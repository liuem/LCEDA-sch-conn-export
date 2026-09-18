const fs = require('node:fs');
const process = require('node:process');
const JSZip = require('jszip');

const pkg = process.argv[2] || 'build/dist/lceda-sch-conn-export_v0.5.2.eext';
JSZip.loadAsync(fs.readFileSync(pkg)).then(async (z) => {
	const names = Object.keys(z.files).filter(n => !z.files[n].dir);
	console.log('包内文件:');
	names.forEach(n => console.log(' -', n));
	if (!names.includes('iframe/settings.html'))
		throw new Error('缺少 iframe/settings.html（设置面板）');
	if (!names.includes('iframe/preview.html'))
		throw new Error('缺少 iframe/preview.html（预览/复制窗口）');
	if (!names.some(n => n.startsWith('images/')))
		throw new Error('缺少 images/（logo 与 banner）');
	const cfg = JSON.parse(await z.file('extension.json').async('string'));
	console.log('版本:', cfg.version, '| 名称:', cfg.name, '| 菜单环境:', Object.keys(cfg.headerMenus).filter(k => cfg.headerMenus[k].length).join(','));
	console.log('菜单函数:', cfg.headerMenus.sch[0].menuItems.map(m => m.registerFn).join(', '));
	if (cfg.uuid.length !== 32)
		throw new Error(`uuid 应为 32 位，实际 ${cfg.uuid.length}`);
	if (cfg.name !== 'lceda-sch-conn-export')
		throw new Error(`name 应为 lceda-sch-conn-export，实际 ${cfg.name}`);
	const src = await z.file('dist/index.js').async('string');
	console.log('bundle 大小:', src.length, '字节');
	// esbuild 默认 ascii charset：中文字符串会被转成 \uXXXX 转义（大写十六进制），两种形式都匹配
	const esc = s => Array.from(s).map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}`).join('');
	const hasStr = s => src.includes(s) || src.includes(esc(s));
	for (const k of ['parseProtel2Netlist', 'buildNetIndex', 'resolveCores', 'renderMarkdown', 'renderSelectionMarkdown', 'buildCorePinRows', 'aggregateComponents', 'collectSnapshot', 'getSelectedDesignators', 'storeLastExport', 'sch_PrimitiveComponent', 'sch_Netlist', 'sch_ManufactureData', 'getNetlistFile', 'netlistEmpty', 'sch_PrimitiveWire', 'getCurrentProjectAllNets', 'netflag', 'extractGeometricNets', 'DisjointSet', 'mergeNetsByName', '几何法', 'Protel2', 'getAllSelectedPrimitives', 'dmt_Project', 'getCurrentProjectInfo', 'sys_IFrame', 'schConnExportConfig', 'schConnExportLast', 'ManufacturerId', 'getState_Footprint', 'getState_SubPartName', 'getState_pinType', 'pinTypeShort', 'netsTouchingCores', '不经过核心器件', '电路连接导出', '网表读取为空', '核心器件', '信号网络总表', '其它器件一览', '已忽略的电源', '未连接引脚', 'No ERC', 'MY_RAIL', 'autoDetectCore', 'coreDesignators', 'ignoreNets', 'powerByPinName', 'includeNetSection', 'filePrefix', 'outputStyle', 'netSectionScope', 'showPinType', '模块连接导出', '器件间互联', '对外信号引脚', '选中器件互联', '需要选中至少 2 个器件'])
		console.log(`  含 ${k}:`, hasStr(k));
	// 关键校验：函数导出（headerMenus registerFn 必须都在 bundle 里）
	for (const fn of ['runExport', 'runSelectionExport', 'openSettingsPanel', 'about']) {
		if (!new RegExp(`(?:function|,)\\s*${fn}\\s*[=(]`).test(src) && !src.includes(`${fn}(`))
			throw new Error(`bundle 缺少导出函数 ${fn}`);
	}
	// 菜单项：模块视图命令
	if (!cfg.headerMenus.sch[0].menuItems.some(m => m.id === 'sce-selection' && m.registerFn === 'runSelectionExport'))
		throw new Error('extension.json 缺少「导出选中器件互联（模块视图）」菜单项');
	const html = await z.file('iframe/settings.html').async('string');
	for (const k of ['schConnExportConfig', 'coreDesignators', 'autoDetectCore', 'autoDetectMinPins', 'ignorePower', 'ignoreNets', 'powerByPinName', 'showUnconnected', 'includeNetSection', 'includeComponentsSection', 'includePowerSummary', 'filePrefix', 'outputStyle', 'netSectionScope', 'showPinType', 'btnSave', 'btnDefaults', 'btnDefaultIgnore'])
		console.log(`  面板含 ${k}:`, html.includes(k));
	const prev = await z.file('iframe/preview.html').async('string');
	for (const k of ['schConnExportLast', 'btnCopy', 'btnSelectAll', 'btnDownload', 'clipboard'])
		console.log(`  预览含 ${k}:`, prev.includes(k));
	// 商店上架要求：功能示意图随包，README 引用（.edaignore 未排除 images/）
	for (const img of ['images/demo-menu.png', 'images/demo-export-full.png', 'images/demo-export-module.png', 'images/demo-settings-1.png', 'images/demo-settings-2.png']) {
		if (!names.includes(img))
			throw new Error(`包缺少示意图 ${img}（商店说明页要求）`);
	}
	const readme = await z.file('README.md').async('string');
	for (const img of ['demo-menu.png', 'demo-export-full.png', 'demo-export-module.png', 'demo-settings-1.png', 'demo-settings-2.png']) {
		if (!readme.includes(img))
			throw new Error(`README 未引用示意图 ${img}`);
	}
	console.log('  示意图 5 张随包且 README 已引用: true');
	// 回归守卫：不引用文件系统/联网接口（静态扫描会触发"外部交互权限"安装提示）
	for (const banned of ['sys_FileSystem', 'saveFileToFileSystem', 'readFileFromFileSystem', 'WebSocket', 'XMLHttpRequest', 'sendBeacon', 'fetch(']) {
		if (src.includes(banned))
			throw new Error(`bundle 引用了外部交互类接口 ${banned}（会触发权限提示）`);
	}
	// 源码目录不应进包（.edaignore 排除 /src/ /test/ /config/ /build/ 等）
	for (const n of names) {
		if (/^(?:src|test|config|build|docs|node_modules)\//.test(n))
			throw new Error(`包内不应包含源码路径：${n}`);
	}
	console.log('✓ 核验通过');
}).catch((e) => {
	console.error('核验失败:', e.message);
	process.exit(1);
});
