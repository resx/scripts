// webdav.js - NodeSeek WebDAV 同步模块
// 提供配置备份、加密存储、自动同步等功能

(function () {
    'use strict';

    // ==== 配置管理 ====
    const CONFIG_KEY = 'nodeseek_webdav_config';
    const LAST_SYNC_KEY = 'nodeseek_webdav_last_sync';
    const BACKUP_FILENAME_PREFIX = 'nodeseek_backup_';

    function getConfig() {
        const defaultConfig = {
            server: '',
            username: '',
            encryptedPassword: '',
            encryptPassword: '',
            syncStrategy: 'merge',
            maxBackups: 5,
            autoSync: false,
            syncInterval: 3600000 // 1 hour
        };

        const stored = localStorage.getItem(CONFIG_KEY);
        if (!stored) return defaultConfig;

        try {
            return { ...defaultConfig, ...JSON.parse(stored) };
        } catch (e) {
            console.error('[WebDAV] 配置解析失败:', e);
            return defaultConfig;
        }
    }

    function saveConfig(config) {
        localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    }

    // ==== 加密工具（AES-256-GCM + PBKDF2）====
    const CryptoHelper = {
        // PBKDF2 密钥派生
        async deriveKey(password, salt) {
            const enc = new TextEncoder();
            const keyMaterial = await crypto.subtle.importKey(
                'raw',
                enc.encode(password),
                { name: 'PBKDF2' },
                false,
                ['deriveKey']
            );

            return crypto.subtle.deriveKey(
                {
                    name: 'PBKDF2',
                    salt: salt,
                    iterations: 100000,
                    hash: 'SHA-256'
                },
                keyMaterial,
                { name: 'AES-GCM', length: 256 },
                false,
                ['encrypt', 'decrypt']
            );
        },

        // AES-256-GCM 加密
        async encrypt(plaintext, password) {
            const enc = new TextEncoder();
            const salt = crypto.getRandomValues(new Uint8Array(16));
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const key = await this.deriveKey(password, salt);

            const ciphertext = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: iv },
                key,
                enc.encode(plaintext)
            );

            // 格式: salt(16) + iv(12) + ciphertext
            const result = new Uint8Array(salt.length + iv.length + ciphertext.byteLength);
            result.set(salt, 0);
            result.set(iv, salt.length);
            result.set(new Uint8Array(ciphertext), salt.length + iv.length);

            // Base64 编码
            return btoa(String.fromCharCode(...result));
        },

        // AES-256-GCM 解密
        async decrypt(ciphertext, password) {
            const enc = new TextDecoder();
            const data = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));

            const salt = data.slice(0, 16);
            const iv = data.slice(16, 28);
            const encrypted = data.slice(28);

            const key = await this.deriveKey(password, salt);

            try {
                const decrypted = await crypto.subtle.decrypt(
                    { name: 'AES-GCM', iv: iv },
                    key,
                    encrypted
                );
                return enc.decode(decrypted);
            } catch (e) {
                throw new Error('解密失败：密码错误或数据损坏');
            }
        }
    };

    // ==== WebDAV 核心操作 ====
    const WebDAVSync = {
        // 测试连接
        async testConnection() {
            const config = getConfig();
            if (!config.server || !config.username) {
                throw new Error('服务器地址和用户名不能为空');
            }

            let password;
            if (config.encryptedPassword && config.encryptPassword) {
                try {
                    password = await CryptoHelper.decrypt(
                        config.encryptedPassword,
                        config.encryptPassword
                    );
                } catch (e) {
                    throw new Error('加密密码错误，无法解密 WebDAV 密码');
                }
            } else {
                throw new Error('WebDAV 密码未设置');
            }

            const auth = btoa(`${config.username}:${password}`);

            const response = await fetch(config.server, {
                method: 'OPTIONS',
                headers: {
                    'Authorization': `Basic ${auth}`
                }
            });

            if (!response.ok) {
                throw new Error(`连接失败: ${response.status} ${response.statusText}`);
            }

            return true;
        },

        // 列出备份文件（PROPFIND）
        async listBackups() {
            const config = getConfig();
            const password = await this._getDecryptedPassword(config);
            const auth = btoa(`${config.username}:${password}`);

            const propfindXml = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:getlastmodified/>
    <d:getcontentlength/>
  </d:prop>
</d:propfind>`;

            const response = await fetch(config.server, {
                method: 'PROPFIND',
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/xml; charset=utf-8',
                    'Depth': '1'
                },
                body: propfindXml
            });

            if (!response.ok) {
                throw new Error(`列出文件失败: ${response.status}`);
            }

            const xmlText = await response.text();
            const parser = new DOMParser();
            const xml = parser.parseFromString(xmlText, 'text/xml');

            const backups = [];
            const responses = xml.getElementsByTagNameNS('DAV:', 'response');

            for (let i = 0; i < responses.length; i++) {
                const href = responses[i].getElementsByTagNameNS('DAV:', 'href')[0]?.textContent;
                if (!href || !href.includes(BACKUP_FILENAME_PREFIX)) continue;

                const displayname = responses[i].getElementsByTagNameNS('DAV:', 'displayname')[0]?.textContent;
                const lastmodified = responses[i].getElementsByTagNameNS('DAV:', 'getlastmodified')[0]?.textContent;
                const size = responses[i].getElementsByTagNameNS('DAV:', 'getcontentlength')[0]?.textContent;

                backups.push({
                    filename: displayname || href.split('/').pop(),
                    lastModified: lastmodified ? new Date(lastmodified) : null,
                    size: parseInt(size) || 0,
                    href: href
                });
            }

            // 按时间倒序排列
            backups.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
            return backups;
        },

        // 上传备份（PUT）
        async upload(data) {
            const config = getConfig();
            const password = await this._getDecryptedPassword(config);
            const auth = btoa(`${config.username}:${password}`);

            // 如果配置了加密密码，加密备份数据
            let uploadData = JSON.stringify(data);
            if (config.encryptPassword) {
                uploadData = await CryptoHelper.encrypt(uploadData, config.encryptPassword);
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `${BACKUP_FILENAME_PREFIX}${timestamp}.json${config.encryptPassword ? '.enc' : ''}`;
            const url = config.server.endsWith('/') ? config.server + filename : config.server + '/' + filename;

            const response = await fetch(url, {
                method: 'PUT',
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/json'
                },
                body: uploadData
            });

            if (!response.ok) {
                throw new Error(`上传失败: ${response.status}`);
            }

            localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString());
            return filename;
        },

        // 下载备份（GET）
        async download(filename) {
            const config = getConfig();
            const password = await this._getDecryptedPassword(config);
            const auth = btoa(`${config.username}:${password}`);

            const url = config.server.endsWith('/') ? config.server + filename : config.server + '/' + filename;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Basic ${auth}`
                }
            });

            if (!response.ok) {
                throw new Error(`下载失败: ${response.status}`);
            }

            let data = await response.text();

            // 如果文件是加密的，解密
            if (filename.endsWith('.enc')) {
                if (!config.encryptPassword) {
                    throw new Error('需要加密密码才能解密备份');
                }
                data = await CryptoHelper.decrypt(data, config.encryptPassword);
            }

            return JSON.parse(data);
        },

        // 删除备份（DELETE）
        async delete(filename) {
            const config = getConfig();
            const password = await this._getDecryptedPassword(config);
            const auth = btoa(`${config.username}:${password}`);

            const url = config.server.endsWith('/') ? config.server + filename : config.server + '/' + filename;

            const response = await fetch(url, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Basic ${auth}`
                }
            });

            if (!response.ok) {
                throw new Error(`删除失败: ${response.status}`);
            }

            return true;
        },

        // 清理旧备份
        async cleanupOldBackups() {
            const config = getConfig();
            const backups = await this.listBackups();

            if (backups.length <= config.maxBackups) return;

            const toDelete = backups.slice(config.maxBackups);
            for (const backup of toDelete) {
                try {
                    await this.delete(backup.filename);
                    console.log(`[WebDAV] 已删除旧备份: ${backup.filename}`);
                } catch (e) {
                    console.error(`[WebDAV] 删除失败: ${backup.filename}`, e);
                }
            }
        },

        // 完整备份流程
        async backup() {
            const backupData = {
                version: '1.0',
                timestamp: new Date().toISOString(),
                data: {
                    blacklist: localStorage.getItem('nodeseek_blacklist'),
                    enhancedConfig: localStorage.getItem('nodeseek_enhanced_block_config'),
                    favorites: localStorage.getItem('nodeseek_favorites'),
                    favoritesCategories: localStorage.getItem('nodeseek_favorites_categories'),
                    browseHistory: localStorage.getItem('nodeseek_browse_history'),
                    friends: localStorage.getItem('nodeseek_friends'),
                    settings: {
                        userInfoDisplay: localStorage.getItem('nodeseek_user_info_display'),
                        viewedHistoryEnabled: localStorage.getItem('nodeseek_viewed_history_enabled'),
                        viewedColor: localStorage.getItem('nodeseek_viewed_color'),
                        collapsedState: localStorage.getItem('nodeseek_buttons_collapsed')
                    }
                }
            };

            const filename = await this.upload(backupData);
            await this.cleanupOldBackups();
            return filename;
        },

        // 完整恢复流程
        async restore(filename, mergeMode = 'merge') {
            const backupData = await this.download(filename);

            if (!backupData.data) {
                throw new Error('备份数据格式无效');
            }

            const data = backupData.data;

            if (mergeMode === 'replace') {
                // 替换模式：直接覆盖
                Object.keys(data).forEach(key => {
                    if (key === 'settings') {
                        Object.keys(data.settings).forEach(settingKey => {
                            if (data.settings[settingKey] !== null) {
                                localStorage.setItem(settingKey, data.settings[settingKey]);
                            }
                        });
                    } else {
                        if (data[key] !== null) {
                            localStorage.setItem(`nodeseek_${key}`, data[key]);
                        }
                    }
                });
            } else {
                // 合并模式：智能合并
                // 黑名单合并
                if (data.blacklist) {
                    const local = JSON.parse(localStorage.getItem('nodeseek_blacklist') || '{}');
                    const remote = JSON.parse(data.blacklist);
                    const merged = { ...local, ...remote };
                    localStorage.setItem('nodeseek_blacklist', JSON.stringify(merged));
                }

                // 增强配置合并
                if (data.enhancedConfig) {
                    const local = JSON.parse(localStorage.getItem('nodeseek_enhanced_block_config') || '{}');
                    const remote = JSON.parse(data.enhancedConfig);

                    // 合并数组
                    if (local.block && remote.block) {
                        local.block.uids = [...new Set([...(local.block.uids || []), ...(remote.block.uids || [])])];
                        local.block.keys = [...new Set([...(local.block.keys || []), ...(remote.block.keys || [])])];
                        local.block.usernames = { ...local.block.usernames, ...remote.block.usernames };
                    }

                    if (local.follow && remote.follow) {
                        local.follow.uids = [...new Set([...(local.follow.uids || []), ...(remote.follow.uids || [])])];
                        local.follow.keys = [...new Set([...(local.follow.keys || []), ...(remote.follow.keys || [])])];
                    }

                    localStorage.setItem('nodeseek_enhanced_block_config', JSON.stringify(local));
                }

                // 收藏合并
                if (data.favorites) {
                    const local = JSON.parse(localStorage.getItem('nodeseek_favorites') || '[]');
                    const remote = JSON.parse(data.favorites);
                    const merged = [...local];

                    remote.forEach(item => {
                        if (!merged.some(m => m.url === item.url)) {
                            merged.push(item);
                        }
                    });

                    localStorage.setItem('nodeseek_favorites', JSON.stringify(merged));
                }

                // 其他数据直接覆盖（设置项等）
                if (data.settings) {
                    Object.keys(data.settings).forEach(key => {
                        if (data.settings[key] !== null) {
                            localStorage.setItem(key, data.settings[key]);
                        }
                    });
                }
            }

            return true;
        },

        // 辅助: 获取解密后的 WebDAV 密码
        async _getDecryptedPassword(config) {
            if (!config.encryptedPassword || !config.encryptPassword) {
                throw new Error('WebDAV 密码未设置');
            }

            try {
                return await CryptoHelper.decrypt(
                    config.encryptedPassword,
                    config.encryptPassword
                );
            } catch (e) {
                throw new Error('加密密码错误，无法解密 WebDAV 密码');
            }
        }
    };

    // ==== UI 界面 ====
    function showConfigDialog() {
        const config = getConfig();

        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.5);
            z-index: 100000;
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: white;
            padding: 20px;
            border-radius: 8px;
            max-width: 600px;
            width: 90%;
            max-height: 80vh;
            overflow-y: auto;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        `;

        dialog.innerHTML = `
            <h2 style="margin-top: 0; color: #333;">WebDAV 同步配置</h2>
            
            <div style="margin-bottom: 15px;">
                <label style="display: block; margin-bottom: 5px; font-weight: bold;">服务器地址:</label>
                <input type="text" id="webdav-server" value="${config.server}" 
                    placeholder="https://dav.example.com/path" 
                    style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px;">
            </div>
            
            <div style="margin-bottom: 15px;">
                <label style="display: block; margin-bottom: 5px; font-weight: bold;">用户名:</label>
                <input type="text" id="webdav-username" value="${config.username}" 
                    style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px;">
            </div>
            
            <div style="margin-bottom: 15px;">
                <label style="display: block; margin-bottom: 5px; font-weight: bold;">WebDAV 密码:</label>
                <input type="password" id="webdav-password" 
                    placeholder="${config.encryptedPassword ? '已设置（留空保持不变）' : '输入密码'}" 
                    style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px;">
            </div>
            
            <div style="margin-bottom: 15px;">
                <label style="display: block; margin-bottom: 5px; font-weight: bold;">加密密码（用于加密备份）:</label>
                <input type="password" id="webdav-encrypt-password" value="${config.encryptPassword}" 
                    placeholder="留空则不加密" 
                    style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px;">
                <small style="color: #666;">建议设置强密码，备份文件将被加密</small>
            </div>
            
            <div style="margin-bottom: 15px;">
                <label style="display: block; margin-bottom: 5px; font-weight: bold;">同步策略:</label>
                <select id="webdav-strategy" style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px;">
                    <option value="merge" ${config.syncStrategy === 'merge' ? 'selected' : ''}>合并（推荐）</option>
                    <option value="replace" ${config.syncStrategy === 'replace' ? 'selected' : ''}>替换</option>
                </select>
            </div>
            
            <div style="margin-bottom: 15px;">
                <label style="display: block; margin-bottom: 5px; font-weight: bold;">保留备份数:</label>
                <input type="number" id="webdav-max-backups" value="${config.maxBackups}" min="1" max="100" 
                    style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px;">
            </div>
            
            <div style="margin-bottom: 20px;">
                <button id="webdav-test-btn" style="
                    padding: 10px 20px;
                    background: #2196F3;
                    color: white;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    margin-right: 10px;
                ">测试连接</button>
                <span id="webdav-test-status" style="color: #666;"></span>
            </div>
            
            <hr style="margin: 20px 0;">
            
            <div style="margin-bottom: 20px;">
                <button id="webdav-backup-now-btn" style="
                    padding: 10px 20px;
                    background: #4CAF50;
                    color: white;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    margin-right: 10px;
                ">立即备份</button>
                <button id="webdav-list-backups-btn" style="
                    padding: 10px 20px;
                    background: #FF9800;
                    color: white;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                ">查看备份</button>
            </div>
            
            <div id="webdav-backups-list" style="
                max-height: 200px;
                overflow-y: auto;
                border: 1px solid #ccc;
                border-radius: 4px;
                padding: 10px;
                display: none;
            "></div>
            
            <hr style="margin: 20px 0;">
            
            <div style="display: flex; justify-content: flex-end; gap: 10px;">
                <button id="webdav-save-btn" style="
                    padding: 10px 20px;
                    background: #4CAF50;
                    color: white;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                ">保存配置</button>
                <button id="webdav-cancel-btn" style="
                    padding: 10px 20px;
                    background: #f44336;
                    color: white;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                ">取消</button>
            </div>
        `;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // 绑定事件
        const closeDialog = () => document.body.removeChild(overlay);

        document.getElementById('webdav-cancel-btn').onclick = closeDialog;

        document.getElementById('webdav-save-btn').onclick = async () => {
            const newConfig = {
                server: document.getElementById('webdav-server').value.trim(),
                username: document.getElementById('webdav-username').value.trim(),
                encryptPassword: document.getElementById('webdav-encrypt-password').value,
                syncStrategy: document.getElementById('webdav-strategy').value,
                maxBackups: parseInt(document.getElementById('webdav-max-backups').value),
                encryptedPassword: config.encryptedPassword // 保留旧密码
            };

            // 如果输入了新的 WebDAV 密码，加密并保存
            const webdavPassword = document.getElementById('webdav-password').value;
            if (webdavPassword) {
                if (!newConfig.encryptPassword) {
                    alert('请设置加密密码以保护 WebDAV 密码');
                    return;
                }

                try {
                    newConfig.encryptedPassword = await CryptoHelper.encrypt(
                        webdavPassword,
                        newConfig.encryptPassword
                    );
                } catch (e) {
                    alert('密码加密失败: ' + e.message);
                    return;
                }
            }

            saveConfig(newConfig);
            alert('配置已保存！');
            closeDialog();
        };

        document.getElementById('webdav-test-btn').onclick = async () => {
            const statusEl = document.getElementById('webdav-test-status');
            statusEl.textContent = '测试中...';
            statusEl.style.color = '#666';

            // 临时保存配置以测试
            const tempConfig = {
                ...config,
                server: document.getElementById('webdav-server').value.trim(),
                username: document.getElementById('webdav-username').value.trim(),
                encryptPassword: document.getElementById('webdav-encrypt-password').value
            };

            const webdavPassword = document.getElementById('webdav-password').value;
            if (webdavPassword && tempConfig.encryptPassword) {
                try {
                    tempConfig.encryptedPassword = await CryptoHelper.encrypt(
                        webdavPassword,
                        tempConfig.encryptPassword
                    );
                } catch (e) {
                    statusEl.textContent = '❌ 加密失败';
                    statusEl.style.color = '#f44336';
                    return;
                }
            }

            const oldConfig = getConfig();
            saveConfig(tempConfig);

            try {
                await WebDAVSync.testConnection();
                statusEl.textContent = '✅ 连接成功！';
                statusEl.style.color = '#4CAF50';
            } catch (e) {
                statusEl.textContent = `❌ ${e.message}`;
                statusEl.style.color = '#f44336';
            } finally {
                saveConfig(oldConfig);
            }
        };

        document.getElementById('webdav-backup-now-btn').onclick = async () => {
            try {
                const filename = await WebDAVSync.backup();
                alert(`备份成功！\n文件名: ${filename}`);
            } catch (e) {
                alert('备份失败: ' + e.message);
            }
        };

        document.getElementById('webdav-list-backups-btn').onclick = async () => {
            const listEl = document.getElementById('webdav-backups-list');
            listEl.style.display = 'block';
            listEl.innerHTML = '<p style="margin:0; color:#666;">加载中...</p>';

            try {
                const backups = await WebDAVSync.listBackups();

                if (backups.length === 0) {
                    listEl.innerHTML = '<p style="margin:0; color:#666;">暂无备份</p>';
                    return;
                }

                listEl.innerHTML = backups.map(backup => `
                    <div style="
                        padding: 8px;
                        margin-bottom: 5px;
                        background: #f5f5f5;
                        border-radius: 4px;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                    ">
                        <div>
                            <div style="font-weight: bold;">${backup.filename}</div>
                            <div style="font-size: 12px; color: #666;">
                                ${backup.lastModified ? backup.lastModified.toLocaleString() : '未知时间'} 
                                (${(backup.size / 1024).toFixed(2)} KB)
                            </div>
                        </div>
                        <button class="webdav-restore-btn" data-filename="${backup.filename}" style="
                            padding: 5px 10px;
                            background: #2196F3;
                            color: white;
                            border: none;
                            border-radius: 4px;
                            cursor: pointer;
                        ">恢复</button>
                    </div>
                `).join('');

                // 绑定恢复按钮
                listEl.querySelectorAll('.webdav-restore-btn').forEach(btn => {
                    btn.onclick = async () => {
                        const filename = btn.dataset.filename;
                        const strategy = getConfig().syncStrategy;

                        if (!confirm(`确定要恢复备份吗？\n文件: ${filename}\n策略: ${strategy === 'merge' ? '合并' : '替换'}`)) {
                            return;
                        }

                        try {
                            await WebDAVSync.restore(filename, strategy);
                            alert('恢复成功！请刷新页面查看效果。');
                            location.reload();
                        } catch (e) {
                            alert('恢复失败: ' + e.message);
                        }
                    };
                });
            } catch (e) {
                listEl.innerHTML = `<p style="margin:0; color:#f44336;">加载失败: ${e.message}</p>`;
            }
        };
    }

    // ==== 自动同步调度器 ====
    let autoSyncTimer = null;

    function startAutoSync() {
        const config = getConfig();
        if (!config.autoSync) return;

        stopAutoSync();
        autoSyncTimer = setInterval(async () => {
            try {
                await WebDAVSync.backup();
                console.log('[WebDAV] 自动备份成功');
            } catch (e) {
                console.error('[WebDAV] 自动备份失败:', e);
            }
        }, config.syncInterval);

        console.log('[WebDAV] 自动同步已启用，间隔:', config.syncInterval / 1000, '秒');
    }

    function stopAutoSync() {
        if (autoSyncTimer) {
            clearInterval(autoSyncTimer);
            autoSyncTimer = null;
        }
    }

    // ==== 暴露全局接口 ====
    window.NodeSeekWebDAV = {
        showDialog: showConfigDialog,
        backup: () => WebDAVSync.backup(),
        restore: (filename, mergeMode) => WebDAVSync.restore(filename, mergeMode),
        testConnection: () => WebDAVSync.testConnection(),
        getConfig: getConfig,
        saveConfig: saveConfig,
        startAutoSync: startAutoSync,
        stopAutoSync: stopAutoSync
    };

    console.log('[WebDAV] 模块已加载');

})();
