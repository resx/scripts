// ========== 黑名单查看功能 ==========
(function () {
    'use strict';

    // 存储键
    const STORAGE_KEY = 'nodeseek_blacklist';
    const LOGS_KEY = 'nodeseek_sign_logs';
    const ENHANCED_BLOCK_CONFIG_KEY = 'nodeseek_enhanced_block_config';  // 新增：增强型配置

    // ==== 增强型屏蔽配置（从 nodeseek.js 迁移）====

    // 获取增强型屏蔽配置
    function getEnhancedBlockConfig() {
        const defaultConfig = {
            block: { uids: [], keys: [], usernames: getBlacklist() },
            follow: { uids: [], keys: [] },
            style: { blockMode: 'highlight', titleColor: '#ff0000', bgColor: '#fff9db' },
            settings: { syncToOfficial: false, showRemark: true }
        };
        const stored = localStorage.getItem(ENHANCED_BLOCK_CONFIG_KEY);
        if (!stored) return defaultConfig;

        try {
            const config = JSON.parse(stored);
            // 合并旧黑名单数据（向后兼容）
            const oldBlacklist = getBlacklist();
            config.block.usernames = { ...oldBlacklist, ...(config.block.usernames || {}) };
            return config;
        } catch (e) {
            console.error('[NodeSeek] 增强配置解析失败:', e);
            return defaultConfig;
        }
    }

    // 保存增强型屏蔽配置
    function setEnhancedBlockConfig(config) {
        // 同步到旧格式黑名单（向后兼容）
        if (config.block && config.block.usernames) {
            setBlacklist(config.block.usernames);
        }
        localStorage.setItem(ENHANCED_BLOCK_CONFIG_KEY, JSON.stringify(config));
    }

    // 读取黑名单
    function getBlacklist() {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    }

    // 保存黑名单
    function setBlacklist(list) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    }

    // 添加日志
    function addLog(message) {
        const now = new Date();
        const timeStr = now.toLocaleString();
        const logEntry = `[${timeStr}] ${message}`;

        // 获取现有日志
        const logs = getLogs();

        // 添加新日志（限制最多保存100条）
        logs.unshift(logEntry);
        if (logs.length > 100) {
            logs.length = 100;
        }

        // 保存日志
        localStorage.setItem(LOGS_KEY, JSON.stringify(logs));

        // 如果日志对话框已打开，则更新其内容
        updateLogDialogIfOpen(logEntry);
    }

    // 获取日志
    function getLogs() {
        return JSON.parse(localStorage.getItem(LOGS_KEY) || '[]');
    }

    // 新增：如果日志对话框已打开，立即更新其内容
    function updateLogDialogIfOpen(newLogEntry) {
        const logDialog = document.getElementById('logs-dialog');
        if (logDialog) {
            const logContent = logDialog.querySelector('pre');
            if (logContent) {
                // 在顶部添加新日志
                logContent.textContent = newLogEntry + '\n' + logContent.textContent;
            }
        }
    }

    // 移除黑名单
    function removeFromBlacklist(username) {
        const list = getBlacklist();
        delete list[username];
        setBlacklist(list);
        // 记录操作日志
        addLog(`将用户 ${username} 从黑名单中移除`);
    }

    // 更新黑名单备注
    function updateBlacklistRemark(username, newRemark) {
        const list = getBlacklist();
        if (list[username]) {
            list[username].remark = newRemark;
            setBlacklist(list);
            // 记录操作日志
            addLog(`更新黑名单用户 ${username} 的备注为: ${newRemark}`);
        }
    }

    // ==== 官方屏蔽列表 API 交互模块（从 nodeseek.js 迁移）====
    const OfficialBlockAPI = {
        cache: new Set(),
        isLoaded: false,

        // 获取官方屏蔽列表
        async fetchList() {
            try {
                const response = await fetch('/api/block-list/list');
                const json = await response.json();

                if (json.success && Array.isArray(json.data)) {
                    this.cache.clear();
                    const userMap = new Map(); // uid -> username

                    json.data.forEach(user => {
                        const uid = String(user.block_member_id);
                        const username = user.block_member_name || '';
                        this.cache.add(uid);
                        userMap.set(uid, username);
                    });

                    this.isLoaded = true;
                    console.log('[NodeSeek] 官方屏蔽列表加载成功，数量:', this.cache.size);
                    return userMap;
                }
                return new Map();
            } catch (err) {
                console.error('[NodeSeek] 获取官方屏蔽列表失败:', err);
                return new Map();
            }
        },

        // 添加到官方屏蔽列表
        async addToOfficial(username, uid) {
            const config = getEnhancedBlockConfig();
            if (!config.settings.syncToOfficial) return;
            if (!this.isLoaded) return;
            if (this.cache.has(String(uid))) return; // 已存在

            try {
                const response = await fetch('/api/block-list/add', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ block_member_name: username })
                });
                const json = await response.json();

                if (json.success) {
                    this.cache.add(String(uid));
                    console.log(`[NodeSeek] 同步到官方成功: ${username}`);
                    addLog(`已将用户 ${username} 同步到官方屏蔽列表`);
                } else {
                    console.warn(`[NodeSeek] 同步失败: ${json.message}`);
                }
            } catch (err) {
                console.error('[NodeSeek] 同步请求失败:', err);
            }
        },

        // 从官方导入到脚本
        importFromOfficial() {
            return this.fetchList().then(userMap => {
                const config = getEnhancedBlockConfig();
                const imported = [];

                userMap.forEach((username, uid) => {
                    // 检查是否已存在
                    if (!config.block.uids.includes(uid)) {
                        config.block.uids.push(uid);
                        imported.push({ uid, username });
                    }

                    // 如果有用户名，也添加到 usernames 字典
                    if (username && !config.block.usernames[username]) {
                        config.block.usernames[username] = {
                            remark: '来自官方屏蔽列表',
                            userId: uid,
                            timestamp: new Date().toISOString(),
                            fromOfficial: true
                        };
                    }
                });

                if (imported.length > 0) {
                    setEnhancedBlockConfig(config);
                    addLog(`从官方导入 ${imported.length} 个屏蔽用户`);
                }

                return { count: imported.length, users: imported };
            });
        }
    };

    // ==== 屏蔽匹配引擎（从 nodeseek.js 迁移）====
    function checkBlockMatch(text, uid, targetConfig) {
        // UID 匹配
        if (uid && targetConfig.uids && targetConfig.uids.includes(String(uid))) {
            return true;
        }

        // 用户名匹配（原 nodeseek.js 逻辑）
        if (targetConfig.usernames) {
            for (const username of Object.keys(targetConfig.usernames)) {
                if (text && text.includes(username)) {
                    return true;
                }
            }
        }

        // 关键词匹配
        if (!text || !targetConfig.keys || !targetConfig.keys.length) {
            return false;
        }

        const lowerText = text.toLowerCase();
        return targetConfig.keys.some(pattern => {
            try {
                // 支持正则表达式 /pattern/flags
                if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
                    const lastSlash = pattern.lastIndexOf('/');
                    const regex = new RegExp(
                        pattern.substring(1, lastSlash),
                        pattern.substring(lastSlash + 1) + 'i'
                    );
                    return regex.test(text);
                }
                // 普通关键词
                return lowerText.includes(pattern.toLowerCase());
            } catch (e) {
                console.error('[NodeSeek] 正则表达式错误:', pattern, e);
                return lowerText.includes(pattern.toLowerCase());
            }
        });
    }

    // ==== 页面应用逻辑（从 nodeseek.js 迁移）====
    function applyEnhancedBlockLogic() {
        const config = getEnhancedBlockConfig();

        // 1. 处理帖子列表
        document.querySelectorAll('.post-list-item').forEach(item => {
            const userLink = item.querySelector('.info-author a');
            const titleLink = item.querySelector('.post-title a');
            if (!userLink || !titleLink) return;

            const uidMatch = userLink.href.match(/\/space\/(\d+)/);
            const uid = uidMatch ? uidMatch[1] : null;
            const username = userLink.textContent.trim();
            const titleText = titleLink.textContent.trim();

            // 检查屏蔽（标题或用户名匹配）
            if (checkBlockMatch(titleText, uid, config.block) ||
                checkBlockMatch(username, uid, config.block)) {

                if (config.style.blockMode === 'hide') {
                    item.style.setProperty('display', 'none', 'important');
                } else {
                    // 高亮模式（保留原有样式）
                    userLink.classList.add('blacklisted-user');
                }

                // 自动同步到官方
                if (uid && config.block.uids.includes(uid)) {
                    OfficialBlockAPI.addToOfficial(username, uid);
                }
                return;
            } else {
                // 取消屏蔽样式
                if (config.style.blockMode === 'hide') {
                    item.style.display = '';
                }
            }

            // 检查关注高亮
            if (checkBlockMatch(titleText, uid, config.follow) ||
                checkBlockMatch(username, uid, config.follow)) {
                item.style.setProperty('background-color', config.style.bgColor, 'important');
                titleLink.style.setProperty('color', config.style.titleColor, 'important');
                titleLink.style.setProperty('font-weight', 'bold', 'important');
            } else {
                // 取消关注样式
                item.style.backgroundColor = '';
                titleLink.style.color = '';
                titleLink.style.fontWeight = '';
            }
        });

        // 2. 处理评论列表
        document.querySelectorAll('li.content-item').forEach(item => {
            const authorLink = item.querySelector('.author-name');
            const contentEl = item.querySelector('.post-content');
            if (!authorLink) return;

            const uidMatch = authorLink.href.match(/\/space\/(\d+)/);
            const uid = uidMatch ? uidMatch[1] : null;
            const username = authorLink.textContent.trim();
            const contentText = contentEl ? contentEl.textContent.trim() : '';

            // 检查屏蔽（内容或用户名匹配）
            if (checkBlockMatch(contentText, uid, config.block) ||
                checkBlockMatch(username, uid, config.block)) {

                if (config.style.blockMode === 'hide') {
                    item.style.setProperty('display', 'none', 'important');
                } else {
                    // 高亮模式（保留原有样式）
                    authorLink.classList.add('blacklisted-user');
                }

                // 自动同步到官方
                if (uid && config.block.uids.includes(uid)) {
                    OfficialBlockAPI.addToOfficial(username, uid);
                }
                return;
            } else {
                // 取消屏蔽样式
                if (config.style.blockMode === 'hide') {
                    item.style.display = '';
                }
            }

            // 检查关注高亮
            if (checkBlockMatch(contentText, uid, config.follow) ||
                checkBlockMatch(username, uid, config.follow)) {
                item.style.setProperty('background-color', config.style.bgColor, 'important');
                authorLink.style.setProperty('color', config.style.titleColor, 'important');
                authorLink.style.setProperty('font-weight', 'bold', 'important');
            } else {
                // 取消关注样式
                item.style.backgroundColor = '';
                authorLink.style.color = '';
                authorLink.style.fontWeight = '';
            }
        });
    }

    // ====== Helper function to make elements draggable ======
    function makeDraggable(element, dragAreaSize = { width: 10, height: 10 }) {
        let isDragging = false;
        let initialMouseX, initialMouseY;
        let initialElementX, initialElementY;

        // Helper to check if the specific point in the hotspot is interactive
        const isPointInteractive = (clientX, clientY, draggableElement) => {
            let elementUnderCursor = document.elementFromPoint(clientX, clientY);
            let currentTarget = elementUnderCursor;

            while (currentTarget && currentTarget !== draggableElement.ownerDocument.body && currentTarget !== draggableElement.ownerDocument.documentElement) {
                if (currentTarget === draggableElement) break; // Reached the draggable element itself

                const tagName = currentTarget.tagName;
                if (['INPUT', 'BUTTON', 'A', 'TEXTAREA', 'SELECT'].includes(tagName) ||
                    currentTarget.isContentEditable ||
                    window.getComputedStyle(currentTarget).cursor === 'pointer' ||
                    (typeof currentTarget.onclick === 'function' && currentTarget !== draggableElement)
                ) {
                    // Ensure this interactive element is a child of 'draggableElement'
                    // and is the one actually under the cursor at clientX, clientY
                    if (draggableElement.contains(currentTarget)) {
                        return true; // Point is obscured by an interactive child
                    }
                }
                currentTarget = currentTarget.parentElement;
            }
            return false; // Point is not obscured by an interactive child
        };

        const onMouseDown = (e) => {
            const elementRect = element.getBoundingClientRect();
            const clickXInElement = e.clientX - elementRect.left;
            const clickYInElement = e.clientY - elementRect.top;

            // 1. Check if the click is within the designated drag area
            if (clickXInElement < 0 || clickXInElement >= dragAreaSize.width ||
                clickYInElement < 0 || clickYInElement >= dragAreaSize.height) {
                return; // Clicked outside the draggable area
            }

            // 2. Check if the point clicked in the hotspot is interactive
            if (isPointInteractive(e.clientX, e.clientY, element)) {
                return; // Clicked on an interactive element within the drag area
            }

            isDragging = true;
            initialMouseX = e.clientX;
            initialMouseY = e.clientY;

            // Ensure element is positioned with left/top for dragging
            const currentStyle = window.getComputedStyle(element);
            if ((element.style.right !== '' && element.style.right !== 'auto') || (currentStyle.right !== 'auto' && (element.style.left === '' || element.style.left === 'auto'))) {
                element.style.left = elementRect.left + 'px';
                element.style.right = 'auto';
            } else if (element.style.left === '' || element.style.left === 'auto' || currentStyle.left === 'auto') {
                element.style.left = elementRect.left + 'px';
            }
            if (element.style.top === '' || element.style.top === 'auto' || currentStyle.top === 'auto') {
                element.style.top = elementRect.top + 'px';
            }
            initialElementX = parseFloat(element.style.left);
            initialElementY = parseFloat(element.style.top);

            element.style.cursor = 'grabbing'; // 拖动时显示抓取光标
            document.body.classList.add('dragging-active');

            document.addEventListener('mousemove', onMouseMoveWhileDragging);
            document.addEventListener('mouseup', onMouseUp);

            e.preventDefault();
        };

        const onMouseMoveWhileDragging = (e) => {
            if (!isDragging) return;

            const dx = e.clientX - initialMouseX;
            const dy = e.clientY - initialMouseY;

            let newLeft = initialElementX + dx;
            let newTop = initialElementY + dy;

            // 添加边界检测，防止元素被拖拽到屏幕外面
            const elementRect = element.getBoundingClientRect();
            const elementWidth = elementRect.width;
            const elementHeight = elementRect.height;
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            // 确保元素至少有50px的部分始终可见
            const minVisibleSize = 50;

            // 限制左边界：最左不能超过 -(elementWidth - minVisibleSize)
            const minLeft = -(elementWidth - minVisibleSize);
            // 限制右边界：最右不能超过 (viewportWidth - minVisibleSize)
            const maxLeft = viewportWidth - minVisibleSize;

            // 限制上边界：最上不能超过 0
            const minTop = 0;
            // 限制下边界：最下不能超过 (viewportHeight - minVisibleSize)
            const maxTop = viewportHeight - minVisibleSize;

            // 应用边界限制
            newLeft = Math.max(minLeft, Math.min(maxLeft, newLeft));
            newTop = Math.max(minTop, Math.min(maxTop, newTop));

            element.style.left = newLeft + 'px';
            element.style.top = newTop + 'px';
        };

        const onMouseUp = (e) => {
            if (!isDragging) return;
            isDragging = false;
            document.body.classList.remove('dragging-active');
            document.removeEventListener('mousemove', onMouseMoveWhileDragging);
            document.removeEventListener('mouseup', onMouseUp);
            // 拖动结束后，根据鼠标当前位置更新光标
            handleHoverCursor(e);
        };

        const handleHoverCursor = (e) => {
            if (isDragging) return; // 如果正在拖动，则光标已为 'grabbing'

            const elementRect = element.getBoundingClientRect();
            const mouseXInElement = e.clientX - elementRect.left;
            const mouseYInElement = e.clientY - elementRect.top;

            let showCustomCursor = false;

            // 检查鼠标是否在元素边界内
            if (mouseXInElement >= 0 && mouseXInElement < elementRect.width &&
                mouseYInElement >= 0 && mouseYInElement < elementRect.height) {
                // 检查是否在指定的拖动热点区域内
                if (mouseXInElement >= 0 && mouseXInElement < dragAreaSize.width &&
                    mouseYInElement >= 0 && mouseYInElement < dragAreaSize.height) {
                    showCustomCursor = true;
                }
            }

            if (showCustomCursor) {
                element.style.cursor = 'all-scroll';
            } else {
                // 如果不在活跃热点区域，则设置默认光标，但仅当鼠标仍在元素上方时。
                if (mouseXInElement >= 0 && mouseXInElement < elementRect.width &&
                    mouseYInElement >= 0 && mouseYInElement < elementRect.height) {
                    element.style.cursor = 'default';
                }
            }
        };

        const onMouseLeaveElement = (e) => {
            if (!isDragging) {
                // 检查鼠标是否确实离开了元素或移动到元素的一部分子元素。
                if (!e.relatedTarget || !element.contains(e.relatedTarget)) {
                    element.style.cursor = 'default';
                }
            }
        };

        element.addEventListener('mousedown', onMouseDown);
        element.addEventListener('mousemove', handleHoverCursor); // 处理悬停时改变光标
        element.addEventListener('mouseleave', onMouseLeaveElement); // 鼠标离开元素时重置光标

        // 添加 CSS 规则以禁用拖动时文本选择
        if (!document.getElementById('dragging-style--userscript')) { // 此脚本的唯一 ID
            const styleTag = document.createElement('style');
            styleTag.id = 'dragging-style--userscript';
            // 修改CSS规则，只在拖拽特定元素时禁用文本选择，而不是整个页面
            styleTag.innerHTML = '.dragging-active .nodeseek-plugin-container { user-select: none !important; -webkit-user-select: none !important; } .dragging-active .nodeseek-plugin-container * { user-select: none !important; -webkit-user-select: none !important; }';
            document.head.appendChild(styleTag);
        }
    }

    // 新增：黑名单弹窗
    function showBlacklistDialog() {
        // 检查弹窗是否已存在
        const existingDialog = document.getElementById('blacklist-dialog');
        if (existingDialog) {
            // 如果已存在，则关闭弹窗
            existingDialog.remove();
            return;
        }

        // 获取黑名单列表并按时间戳降序排序（最新添加的排在最前面）
        const rawList = getBlacklist();
        // 将对象转换为数组，以便进行排序
        let entriesList = Object.entries(rawList).map(([username, info]) => ({
            username,
            ...info
        }));
        // 按时间戳降序排序
        entriesList.sort((a, b) => {
            // 如果没有时间戳，则排在后面
            if (!a.timestamp) return 1;
            if (!b.timestamp) return -1;
            // 比较时间戳，降序排列
            return new Date(b.timestamp) - new Date(a.timestamp);
        });

        // 不再记录查看黑名单的操作
        const dialog = document.createElement('div');
        dialog.id = 'blacklist-dialog';
        dialog.style.position = 'fixed';
        dialog.style.top = '60px';
        dialog.style.right = '16px';
        dialog.style.zIndex = 10000;
        dialog.style.background = '#fff';
        dialog.style.border = '1px solid #ccc';
        dialog.style.borderRadius = '8px';
        dialog.style.boxShadow = '0 2px 12px rgba(0,0,0,0.15)';
        dialog.style.padding = '18px 20px 12px 20px';
        // 移除固定minWidth设置，在PC设备上保留
        if (window.innerWidth > 767) {
            dialog.style.minWidth = '435px';  // 只在PC设备上设置
        }
        dialog.style.maxHeight = '60vh';
        dialog.style.overflowY = 'auto';
        dialog.style.overflowX = 'auto';

        // 设备检测与移动端适配
        const isMobile = (window.NodeSeekFilter && typeof window.NodeSeekFilter.isMobileDevice === 'function')
            ? window.NodeSeekFilter.isMobileDevice()
            : (window.innerWidth <= 767);
        if (isMobile) {
            dialog.style.width = '95%';
            dialog.style.minWidth = 'unset';
            dialog.style.maxWidth = '95%';
            dialog.style.left = '50%';
            dialog.style.top = '50%';
            dialog.style.transform = 'translate(-50%, -50%)';
            dialog.style.right = 'auto';
            dialog.style.maxHeight = '85vh';
            dialog.style.padding = '12px 8px 8px 8px';
            dialog.style.overflowY = 'auto';
            dialog.style.overflowX = 'hidden';
            dialog.style.borderRadius = '12px';
            dialog.style.boxShadow = '0 4px 24px rgba(0,0,0,0.25)';
        }

        // 标题和关闭按钮
        const title = document.createElement('div');
        title.textContent = '黑名单列表';
        title.style.fontWeight = 'bold';
        title.style.fontSize = '16px';
        title.style.marginBottom = '10px';
        dialog.appendChild(title);
        const closeBtn = document.createElement('span');
        closeBtn.textContent = '×';
        closeBtn.style.position = 'absolute';
        closeBtn.style.right = '12px';
        closeBtn.style.top = '8px';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.fontSize = '20px';
        closeBtn.className = 'close-btn'; // 添加类名便于CSS选择器选中
        closeBtn.onclick = function () { dialog.remove(); };
        dialog.appendChild(closeBtn);

        // 搜索框容器与输入
        const searchWrap = document.createElement('div');
        searchWrap.style.margin = '8px 0 10px 0';
        const searchInput = document.createElement('input');
        searchInput.type = 'search';
        searchInput.placeholder = '搜索用户名或备注';
        searchInput.style.width = '100%';
        searchInput.style.boxSizing = 'border-box';
        searchInput.style.padding = isMobile ? '10px 12px' : '6px 8px';
        searchInput.style.border = '1px solid #ccc';
        searchInput.style.borderRadius = '4px';
        searchInput.style.fontSize = isMobile ? '16px' : '14px';
        searchWrap.appendChild(searchInput);
        dialog.appendChild(searchWrap);

        // 简繁体与大小写标准化函数（优先使用 NodeSeekFilter.normalizeText）
        const normalizeForSearch = function (text) {
            const s = (text || '').toString();
            if (window.NodeSeekFilter && typeof window.NodeSeekFilter.normalizeText === 'function') {
                return window.NodeSeekFilter.normalizeText(s);
            }
            let t = s.replace(/\s+/g, '').toLowerCase();
            if (window.NodeSeekFilter && typeof window.NodeSeekFilter.convertTraditionalToSimplified === 'function') {
                t = window.NodeSeekFilter.convertTraditionalToSimplified(t);
            }
            return t;
        };

        // 列表内容
        const table = document.createElement('table');
        table.style.width = '100%';
        table.style.borderCollapse = 'collapse';
        // 设置所有表格单元格垂直对齐方式为底部对齐
        table.style.verticalAlign = 'bottom';
        table.innerHTML = '<thead><tr><th style="text-align:left;font-size:13px;vertical-align:bottom;">用户名</th><th style="text-align:left;font-size:13px;padding-left:5px;min-width:135px;vertical-align:bottom;">备注</th><th style="text-align:left;font-size:13px;padding-left:0;position:relative;left:-2px;vertical-align:bottom;">拉黑时间</th><th style="text-align:left;font-size:13px;padding-left:5px;vertical-align:bottom;">页面</th><th style="vertical-align:bottom;"></th></tr></thead>';
        const tbody = document.createElement('tbody');
        // 使用排序后的数组遍历黑名单
        entriesList.forEach(entry => {
            const username = entry.username;
            const info = entry; // 包含了用户名和其他信息
            const tr = document.createElement('tr');
            tr.style.borderBottom = '1px solid #eee';
            // 便于后续搜索过滤
            tr.dataset.username = normalizeForSearch(String(username));
            tr.dataset.remark = normalizeForSearch(String(info.remark || ''));
            // 用户名
            const tdUser = document.createElement('td');
            tdUser.style.verticalAlign = 'bottom';

            // 创建链接替代纯文本
            const nameLink = document.createElement('a');
            nameLink.textContent = username;
            nameLink.style.color = '#d00';
            nameLink.style.fontWeight = 'bold';
            nameLink.style.fontSize = '13px';
            nameLink.style.whiteSpace = 'nowrap'; // 确保用户名不换行
            nameLink.title = '点击访问主页';
            nameLink.target = '_blank';

            // 优先使用存储的用户ID
            const userId = info.userId;

            // 如果存储了用户ID，直接使用
            if (userId) {
                nameLink.href = 'https://www.nodeseek.com/space/' + userId + '#/general';
            } else {
                // 如果没有存储的用户ID，尝试从页面链接中获取
                let foundUserId = null;
                const userLinks = Array.from(document.querySelectorAll('a.author-name'))
                    .filter(a => a.textContent.trim() === username);

                if (userLinks.length > 0) {
                    for (const link of userLinks) {
                        if (link.href) {
                            const match = link.href.match(/\/space\/(\d+)/);
                            if (match) {
                                foundUserId = match[1];

                                // 同时更新到存储中，以便下次使用
                                const list = getBlacklist();
                                if (list[username]) {
                                    list[username].userId = foundUserId;
                                    setBlacklist(list);
                                }

                                break;
                            }
                        }
                    }
                }

                if (foundUserId) {
                    nameLink.href = 'https://www.nodeseek.com/space/' + foundUserId + '#/general';
                } else if (info.url) {
                    // 使用拉黑时的页面链接，如果有楼层ID则添加锚点
                    let targetUrl = info.url;

                    // 检查是否有楼层信息并且原始URL不含楼层锚点
                    if (info.postId && !targetUrl.includes('#post-') && !targetUrl.includes('#' + info.postId.replace('post-', ''))) {
                        // 移除可能存在的其他锚点
                        targetUrl = targetUrl.split('#')[0];
                        // 添加楼层锚点，去除post-前缀
                        targetUrl += '#' + info.postId.replace('post-', '');
                    }

                    nameLink.href = targetUrl;
                }
            }

            tdUser.appendChild(nameLink);
            tr.appendChild(tdUser);
            // 备注
            const tdRemark = document.createElement('td');
            // 根据设备类型调整显示方式
            const isMobile = window.innerWidth <= 767;

            if (!isMobile) {
                // PC端显示方式 - 增加备注显示空间，即使为空也保持固定宽度
                tdRemark.textContent = info.remark || '　';  // 使用全角空格保持宽度
                tdRemark.style.fontSize = '12px';
                tdRemark.style.minWidth = '135px';  // 最小宽度确保空白时也占位
                tdRemark.style.maxWidth = '135px';  // 最大宽度限制
                tdRemark.style.overflow = 'hidden';
                tdRemark.style.textOverflow = 'ellipsis';
                tdRemark.style.whiteSpace = 'nowrap';
                tdRemark.style.display = 'inline-block'; // 确保宽度生效
                tdRemark.style.verticalAlign = 'bottom'; // 下对齐
                tdRemark.style.paddingTop = '2px'; // 向下移动2px
            } else {
                // 移动端显示方式
                tdRemark.textContent = info.remark || '　';  // 使用全角空格保持宽度
                tdRemark.style.verticalAlign = 'bottom'; // 下对齐
            }

            tdRemark.style.textAlign = 'left';
            tdRemark.style.cssText += 'text-align:left !important;';
            tdRemark.style.cursor = 'pointer';
            tdRemark.style.paddingLeft = '5px'; // 向右移动5px

            // 设置title为备注的完整内容
            tdRemark.title = info.remark ? info.remark : '点击编辑备注';

            // 备注编辑功能 - 使用固定定位的编辑框，不干扰现有布局
            tdRemark.onclick = function (e) {
                e.stopPropagation();
                e.preventDefault();

                // 防止重复点击
                if (document.getElementById('blacklist-edit-overlay')) return;

                const currentText = (info.remark || '');

                // 获取单元格在页面上的位置
                const cellRect = tdRemark.getBoundingClientRect();

                // 创建遮罩层
                const overlay = document.createElement('div');
                overlay.id = 'blacklist-edit-overlay';
                overlay.style.position = 'fixed';
                overlay.style.top = '0';
                overlay.style.left = '0';
                overlay.style.width = '100%';
                overlay.style.height = '100%';
                overlay.style.backgroundColor = 'transparent';
                overlay.style.zIndex = '10001';

                // 创建编辑框
                const editor = document.createElement('div');
                editor.style.position = 'fixed';
                editor.style.top = cellRect.top + 'px';
                editor.style.left = cellRect.left + 'px';
                editor.style.width = cellRect.width + 'px';
                editor.style.height = cellRect.height + 'px';
                editor.style.zIndex = '10002';
                editor.style.backgroundColor = '#fff';
                editor.style.boxShadow = '0 0 5px rgba(0,0,0,0.3)';
                editor.style.padding = '0';
                editor.style.boxSizing = 'border-box';
                editor.style.borderRadius = '3px';

                // 创建输入框
                const input = document.createElement('input');
                input.type = 'text';
                input.value = currentText;
                input.style.width = '100%';
                input.style.height = '100%';
                input.style.border = '1px solid #d00';
                input.style.borderRadius = '3px';
                input.style.padding = '0 5px';
                input.style.boxSizing = 'border-box';
                input.style.fontSize = '12px';
                input.style.outline = 'none';

                // 添加到文档
                editor.appendChild(input);
                overlay.appendChild(editor);
                document.body.appendChild(overlay);

                // 聚焦输入框但不选择文本
                input.focus();
                // 将光标放在文本末尾
                const textLength = input.value.length;
                input.setSelectionRange(textLength, textLength);

                // 函数：关闭编辑并保存
                const closeEditor = function (save) {
                    const newText = save ? input.value : currentText;

                    // 移除编辑器
                    document.body.removeChild(overlay);

                    // 如果有变更且选择保存，则更新内容
                    if (save && newText !== currentText) {
                        // 更新显示的备注
                        tdRemark.textContent = newText || '　';  // 使用全角空格保持宽度
                        tdRemark.title = newText || '点击编辑备注';

                        // 更新存储
                        updateBlacklistRemark(username, newText);

                        // 不再在这里异步更新页面上的其他备注显示
                        // 这会导致备注出现在错误位置
                        // 由于已经不刷新页面，用户需要手动刷新页面才能看到所有更新

                        // 更新信息对象
                        info.remark = newText;
                    }
                };

                // 点击遮罩层关闭编辑器
                overlay.addEventListener('mousedown', function (e) {
                    if (e.target === overlay) {
                        closeEditor(true);
                    }
                });

                // 键盘事件
                input.addEventListener('keydown', function (e) {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        closeEditor(true);
                    } else if (e.key === 'Escape') {
                        e.preventDefault();
                        closeEditor(false);
                    }
                });
            };
            tr.appendChild(tdRemark);
            // 拉黑时间
            const tdTime = document.createElement('td');
            tdTime.style.verticalAlign = 'bottom';
            if (info.timestamp) {
                const date = new Date(info.timestamp);
                tdTime.textContent = date.getFullYear() + '-' +
                    String(date.getMonth() + 1).padStart(2, '0') + '-' +
                    String(date.getDate()).padStart(2, '0') + ' ' +
                    String(date.getHours()).padStart(2, '0') + ':' +
                    String(date.getMinutes()).padStart(2, '0') + ':' +
                    String(date.getSeconds()).padStart(2, '0');
            } else {
                tdTime.textContent = '';
            }
            tdTime.style.fontSize = '11px';
            tdTime.style.whiteSpace = 'nowrap'; // 确保时间不换行
            tdTime.style.textAlign = 'left'; // 左对齐，与表头对齐
            tdTime.style.paddingLeft = '0'; // 去除左边距
            tdTime.style.position = 'relative';
            tdTime.style.left = '-2px';
            tr.appendChild(tdTime);
            // 拉黑页面
            const tdUrl = document.createElement('td');
            tdUrl.style.verticalAlign = 'bottom';
            tdUrl.style.paddingLeft = '5px'; // 减少左边距
            if (info.url) {
                const a = document.createElement('a');
                // 使用拉黑时的页面链接，如果有楼层ID则添加锚点
                let targetUrl = info.url;

                // 检查是否有楼层信息并且原始URL不含楼层锚点
                if (info.postId && !targetUrl.includes('#post-') && !targetUrl.includes('#' + info.postId.replace('post-', ''))) {
                    // 移除可能存在的其他锚点
                    targetUrl = targetUrl.split('#')[0];
                    // 添加楼层锚点，去除post-前缀
                    targetUrl += '#' + info.postId.replace('post-', '');
                }

                a.href = targetUrl;
                a.textContent = info.postId ? `楼层#${info.postId.replace('post-', '')}` : '页面';
                a.target = '_blank';
                a.style.fontSize = '11px';
                a.style.color = '#06c';
                tdUrl.appendChild(a);
            }
            tr.appendChild(tdUrl);
            // 操作
            const tdOp = document.createElement('td');
            tdOp.style.verticalAlign = 'bottom';
            tdOp.style.paddingLeft = '3px'; // 向右移动3px
            const removeBtn = document.createElement('button');
            removeBtn.textContent = '移除';
            removeBtn.className = 'blacklist-btn red';
            removeBtn.style.fontSize = '11px';
            removeBtn.onclick = function () {
                if (confirm('确定要移除该用户？')) {
                    // 从黑名单存储中移除
                    removeFromBlacklist(username);

                    // 从界面上移除对应行
                    tr.style.opacity = '0.5';
                    tr.style.transition = 'opacity 0.2s';

                    setTimeout(function () {
                        tr.remove();

                        // 如果黑名单列表为空，显示空提示
                        const tbody = document.querySelector('#blacklist-dialog tbody');
                        if (tbody && tbody.children.length === 0) {
                            const empty = document.createElement('div');
                            empty.textContent = '暂无黑名单用户';
                            empty.style.textAlign = 'center';
                            empty.style.color = '#888';
                            empty.style.margin = '18px 0 8px 0';
                            document.querySelector('#blacklist-dialog table').after(empty);
                        }

                        // 从页面上移除该用户的备注标记
                        document.querySelectorAll('a.author-name').forEach(function (a) {
                            if (a.textContent.trim() === username) {
                                a.style.color = ''; // 恢复默认颜色
                                const remark = a.parentNode.querySelector('.blacklist-remark');
                                if (remark) remark.remove();
                            }
                        });
                    }, 200);
                }
            };
            tdOp.appendChild(removeBtn);
            tr.appendChild(tdOp);
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        dialog.appendChild(table);

        // 搜索空结果提示
        const searchEmpty = document.createElement('div');
        searchEmpty.id = 'blacklist-search-empty';
        searchEmpty.textContent = '未找到匹配项';
        searchEmpty.style.textAlign = 'center';
        searchEmpty.style.color = '#888';
        searchEmpty.style.margin = '10px 0 4px 0';
        searchEmpty.style.display = 'none';
        dialog.appendChild(searchEmpty);

        // 绑定搜索输入事件（支持繁体）
        searchInput.addEventListener('input', function () {
            const kw = normalizeForSearch(searchInput.value.trim());
            let visibleCount = 0;
            tbody.querySelectorAll('tr').forEach(tr => {
                const match = !kw || tr.dataset.username.includes(kw) || tr.dataset.remark.includes(kw);
                tr.style.display = match ? '' : 'none';
                if (match) visibleCount++;
            });
            searchEmpty.style.display = visibleCount === 0 ? '' : 'none';
        });

        // 空提示
        if (entriesList.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = '暂无黑名单用户';
            empty.style.textAlign = 'center';
            empty.style.color = '#888';
            empty.style.margin = '18px 0 8px 0';
            dialog.appendChild(empty);
        }

        document.body.appendChild(dialog);
        if (!isMobile && typeof makeDraggable === 'function') {
            makeDraggable(dialog, { width: 50, height: 50 });
        }
    }

    // ==== 增强配置对话框（新增）====
    function showEnhancedConfigDialog() {
        // 检查是否已存在
        const existing = document.getElementById('enhanced-config-dialog');
        if (existing) {
            existing.remove();
            return;
        }

        // 获取当前配置
        const config = getEnhancedBlockConfig();

        // 创建对话框
        const dialog = document.createElement('div');
        dialog.id = 'enhanced-config-dialog';
        dialog.className = 'nodeseek-plugin-container';
        dialog.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: 10001;
            background: #fff;
            border: 1px solid #ccc;
            border-radius: 8px;
            box-shadow: 0 4px 24px rgba(0,0,0,0.3);
            padding: 20px;
            min-width: 500px;
            max-width: 90vw;
            max-height: 80vh;
            overflow-y: auto;
        `;

        dialog.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                <h3 style="margin: 0;">增强型黑名单配置</h3>
                <span class="close-btn" style="cursor: pointer; font-size: 24px;">×</span>
            </div>

            <fieldset style="margin-bottom: 15px; border: 1px solid #ddd; border-radius: 4px; padding: 10px;">
                <legend style="font-weight: bold;">屏蔽设置</legend>
                
                <div style="margin-bottom: 10px;">
                    <label style="display: block; margin-bottom: 5px;">UID 黑名单</label>
                    <textarea id="uid-list" placeholder="每行一个 UID&#10;12345&#10;67890" 
                        style="width: 100%; min-height: 60px; padding: 5px; box-sizing: border-box; font-family: monospace;"
                    >${config.block.uids.join('\n')}</textarea>
                </div>

                <div style="margin-bottom: 10px;">
                    <label style="display: block; margin-bottom: 5px;">关键词屏蔽</label>
                    <textarea id="keyword-list" placeholder="每行一个关键词，支持正则&#10;垃圾广告&#10;/spam/i" 
                        style="width: 100%; min-height: 60px; padding: 5px; box-sizing: border-box; font-family: monospace;"
                    >${config.block.keys.join('\n')}</textarea>
                    <small style="color: #666;">支持正则表达式，格式：/pattern/flags</small>
                </div>

                <div style="margin-bottom: 10px;">
                    <label style="display: block; margin-bottom: 5px;">屏蔽模式：</label>
                    <select id="block-mode" style="padding: 4px; width: 150px;">
                        <option value="hide" ${config.style.blockMode === 'hide' ? 'selected' : ''}>隐藏</option>
                        <option value="highlight" ${config.style.blockMode === 'highlight' ? 'selected' : ''}>高亮</option>
                    </select>
                </div>
            </fieldset>

            <fieldset style="margin-bottom: 15px; border: 1px solid #ddd; border-radius: 4px; padding: 10px;">
                <legend style="font-weight: bold;">关注设置</legend>
                
                <div style="margin-bottom: 10px;">
                    <label style="display: block; margin-bottom: 5px;">关注 UID</label>
                    <textarea id="follow-uid-list" placeholder="每行一个 UID" 
                        style="width: 100%; min-height: 40px; padding: 5px; box-sizing: border-box; font-family: monospace;"
                    >${config.follow.uids.join('\n')}</textarea>
                </div>

                <div style="margin-bottom: 10px;">
                    <label style="display: block; margin-bottom: 5px;">关注关键词</label>
                    <textarea id="follow-keyword-list" placeholder="每行一个关键词" 
                        style="width: 100%; min-height: 40px; padding: 5px; box-sizing: border-box; font-family: monospace;"
                    >${config.follow.keys.join('\n')}</textarea>
                </div>

                <div style="display: flex; gap: 15px; align-items: center;">
                    <label>
                        标题颜色：
                        <input type="color" id="title-color" value="${config.style.titleColor}" 
                            style="margin-left: 5px; width: 50px; height: 30px; cursor: pointer;">
                    </label>
                    <label>
                        背景颜色：
                        <input type="color" id="bg-color" value="${config.style.bgColor}" 
                            style="margin-left: 5px; width: 50px; height: 30px; cursor: pointer;">
                    </label>
                </div>
            </fieldset>

            <fieldset style="margin-bottom: 15px; border: 1px solid #ddd; border-radius: 4px; padding: 10px;">
                <legend style="font-weight: bold;">官方 API 联动</legend>
                
                <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px;">
                    <input type="checkbox" id="sync-to-official" ${config.settings.syncToOfficial ? 'checked' : ''}>
                    <span>新增黑名单时自动同步到官方</span>
                </label>

                <div style="margin-top: 10px; display: flex; gap: 10px; align-items: center;">
                    <button id="import-from-official" style="padding: 6px 12px; cursor: pointer; background: #4CAF50; color: white; border: none; border-radius: 4px;">
                        从官方导入黑名单
                    </button>
                    <span id="import-status" style="color: #666;"></span>
                </div>
            </fieldset>

            <div style="text-align: right; margin-top: 20px; padding-top: 15px; border-top: 1px solid #eee;">
                <button id="save-config" style="padding: 8px 20px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; margin-right: 10px; font-weight: bold;">
                    保存配置
                </button>
                <button id="cancel-config" style="padding: 8px 20px; background: #ccc; color: #333; border: none; border-radius: 4px; cursor: pointer;">
                    取消
                </button>
            </div>
        `;

        document.body.appendChild(dialog);

        // 绑定事件
        dialog.querySelector('.close-btn').onclick = () => dialog.remove();
        dialog.querySelector('#cancel-config').onclick = () => dialog.remove();

        dialog.querySelector('#save-config').onclick = () => {
            // 收集配置
            const newConfig = {
                block: {
                    uids: document.getElementById('uid-list').value.split('\n').map(x => x.trim()).filter(x => x),
                    keys: document.getElementById('keyword-list').value.split('\n').map(x => x.trim()).filter(x => x),
                    usernames: config.block.usernames  // 保留原有
                },
                follow: {
                    uids: document.getElementById('follow-uid-list').value.split('\n').map(x => x.trim()).filter(x => x),
                    keys: document.getElementById('follow-keyword-list').value.split('\n').map(x => x.trim()).filter(x => x)
                },
                style: {
                    blockMode: document.getElementById('block-mode').value,
                    titleColor: document.getElementById('title-color').value,
                    bgColor: document.getElementById('bg-color').value
                },
                settings: {
                    syncToOfficial: document.getElementById('sync-to-official').checked,
                    showRemark: true
                }
            };

            // 保存
            setEnhancedBlockConfig(newConfig);
            alert('配置已保存！刷新页面后生效。');
            dialog.remove();

            // 刷新页面以应用新配置
            if (confirm('是否立即刷新页面应用配置？')) {
                location.reload();
            }
        };

        // 从官方导入
        dialog.querySelector('#import-from-official').onclick = async () => {
            const statusEl = document.getElementById('import-status');
            statusEl.textContent = '导入中...';
            statusEl.style.color = '#666';

            try {
                const result = await OfficialBlockAPI.importFromOfficial();
                statusEl.textContent = `✅ 成功导入 ${result.count} 个用户`;
                statusEl.style.color = '#4CAF50';

                // 重新加载配置以更新界面
                setTimeout(() => {
                    dialog.remove();
                    showEnhancedConfigDialog();
                }, 1500);
            } catch (error) {
                statusEl.textContent = '❌ 导入失败: ' + error.message;
                statusEl.style.color = '#f44336';
            }
        };

        // 使对话框可拖动
        if (typeof makeDraggable === 'function') {
            makeDraggable(dialog, { width: 100, height: 40 });
        }
    }

    // ==== 初始化增强型黑名单功能 ====
    window.addEventListener('load', () => {
        const config = getEnhancedBlockConfig();

        // 如果开启了官方同步，加载官方屏蔽列表
        if (config.settings.syncToOfficial) {
            OfficialBlockAPI.fetchList().catch(err => {
                console.error('[NodeSeek] 初始化官方屏蔽列表失败:', err);
            });
        }

        // 执行一次屏蔽逻辑
        applyEnhancedBlockLogic();

        // 监听 DOM 变化
        const enhancedBlockObserver = new MutationObserver(() => {
            applyEnhancedBlockLogic();
        });

        enhancedBlockObserver.observe(document.body, {
            childList: true,
            subtree: true
        });

        console.log('[NodeSeek] 增强型黑名单已启用');
    });

    // 暴露给全局
    window.NodeSeekBlacklistViewer = {
        showBlacklistDialog: showBlacklistDialog,
        updateBlacklistRemark: updateBlacklistRemark,
        showEnhancedConfigDialog: showEnhancedConfigDialog,
        getEnhancedBlockConfig: getEnhancedBlockConfig,
        setEnhancedBlockConfig: setEnhancedBlockConfig,
        OfficialBlockAPI: OfficialBlockAPI
    };

    // 暴露 makeDraggable 函数到全局，供其他模块使用
    window.makeDraggable = makeDraggable;

})();
