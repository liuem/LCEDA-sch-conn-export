import type { SchSnapshot } from '../src/types.ts';
/**
 * 离线测试 / Offline tests（不依赖 EDA 运行时，node 直接运行）
 *
 * 覆盖：Protel2 网表解析、名单/通配匹配、电源分类（网络名 + 引脚名兜底）、
 * 位号工具（多子部件聚合/基准位号/自然排序）、核心器件解析（选中 ∪ 配置 ∪ 自动识别）、
 * 连接模型构建（对端排除自身/未匹配统计/信号连接枚举）、Markdown 渲染
 * （核心器件表/网络总表/器件一览/电源汇总/章节开关/转义）、
 * 适配层（配置存取清洗、导出文件、上次导出缓存、选中位号提取、整图快照收集）。
 *
 * 用法：node test/run-offline.ts
 */
import process from 'node:process';
import {
	aggregateComponents,
	collectSnapshot,
	getSelectedDesignators,
	loadConfig,
	loadLastExport,
	saveConfig,
	storeLastExport,
} from '../src/eda-adapter.ts';
import { defaultFileName, formatTimestamp, renderMarkdown, renderSelectionMarkdown, summaryText } from '../src/markdown.ts';
import {
	baseDesignator,
	buildCoreComponents,
	buildCorePinRows,
	buildNetIndex,
	compilePatterns,
	componentSignalPins,
	globToRegExp,
	isIgnoredNet,
	isPowerPinName,
	matchAny,
	naturalCompare,
	netStats,
	netsTouchingCores,
	parseDesignatorList,
	parseList,
	pinRefLabel,
	pinTypeShort,
	powerNets,
	resolveCores,
	signalNets,
} from '../src/model.ts';
import { parseProtel2Netlist, pinKey } from '../src/netlist.ts';
import { DEFAULT_CONFIG, DEFAULT_IGNORE_NETS } from '../src/types.ts';
import { buildProtel2Text, buildSnapshot, cfgOf, installEdaMock } from './fixture.ts';

let failures = 0;
let checks = 0;

function ok(cond: boolean, label: string, detail = ''): void {
	checks++;
	if (!cond) {
		failures++;
		console.error(`  ✗ ${label}${detail ? `：${detail}` : ''}`);
	}
}

function eq<T>(actual: T, expected: T, label: string): void {
	ok(actual === expected, label, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

function deepEq<T>(actual: T, expected: T, label: string): void {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	ok(a === b, label, `实际 ${a}，期望 ${b}`);
}

function includes(haystack: string, needle: string, label: string): void {
	ok(haystack.includes(needle), label, `未找到片段：${JSON.stringify(needle)}`);
}

/* ================= 1. Protel2 网表解析 ================= */
function test01(): Promise<void> {
	console.log('· Protel2 网表解析');
	const parsed = parseProtel2Netlist(buildProtel2Text());
	eq(parsed.nets.length, 5, '网络块数量');
	eq(parsed.nets[0].name, 'KEY1', '带引号网络名去引号');
	eq(parsed.nets[0].members.length, 3, '成员数（计数行被跳过）');
	deepEq(parsed.nets[4].members.map(m => `${m.designator}-${m.pinNumber}`), ['U2A-3', 'U2B-4'], '成员顺序与位号保留');
	eq(parsed.pinNets.get(pinKey('U1', '42')), 'I2C1_SCL', '引脚->网络映射');
	eq(parsed.pinNets.get(pinKey('U2A', '3')), 'NAY', '多子部件位号键');
	eq(parsed.pinNets.size, 3 + 4 + 6 + 5 + 2, '引脚映射总数（器件块行不计入）');

	eq(parseProtel2Netlist('').nets.length, 0, '空文本 -> 空结果');
	eq(parseProtel2Netlist('random\ngarbage\n[').nets.length, 0, '脏文本不炸');
	// 未闭合网络块（文件截断兜底）
	const truncated = parseProtel2Netlist('(\nNET_A\nU1-1\n');
	eq(truncated.nets.length, 1, '未闭合网络块也保留');
	eq(truncated.nets[0].name, 'NET_A', '截断块网络名');
	// 位号含 '-'：引脚号取最后一个 '-' 之后
	const dashed = parseProtel2Netlist('(\nN1\nA-1-B-3\n)');
	eq(dashed.pinNets.get(pinKey('A-1-B', '3')), 'N1', '含 - 位号');
}

/* ================= 2. 名单与通配 ================= */
function test02(): Promise<void> {
	console.log('· 名单与通配匹配');
	deepEq(parseList('a, b；c\nd，e'), ['a', 'b', 'c', 'd', 'e'], '名单分隔符（中英文逗号/分号/换行）');
	deepEq(parseList('  ,, ;; \n'), [], '空项剔除');
	deepEq(parseDesignatorList('U1 u2,U3；U4'), ['U1', 'u2', 'U3', 'U4'], '位号列表（含空白分隔）');

	ok(globToRegExp('GND*').test('GNDIO'), 'GND* 匹配 GNDIO');
	ok(!globToRegExp('GND').test('GNDX'), '整词匹配（GND 不匹配 GNDX）');
	ok(globToRegExp('VREF*').test('VREF+'), 'VREF* 匹配 VREF+');
	ok(globToRegExp('+*').test('+3V3'), '+* 匹配 +3V3');
	ok(globToRegExp('VDD?').test('VDDA'), '? 匹配单字符');
	ok(globToRegExp('A+B').test('A+B'), '正则特殊字符转义 +');
	ok(!globToRegExp('A+B').test('AAB'), '转义后不做任意匹配');
	ok(compilePatterns(['vdd*'])[0].test('VDDIO'), '忽略大小写');

	ok(matchAny('3V3', compilePatterns(parseList(DEFAULT_IGNORE_NETS))), '默认名单命中 3V3');
	ok(!matchAny('KEY1', compilePatterns(parseList(DEFAULT_IGNORE_NETS))), '默认名单不误伤 KEY1');
}

/* ================= 3. 电源/地分类 ================= */
function test03(): Promise<void> {
	console.log('· 电源分类');
	for (const n of ['GND', 'AGND', 'DGND', 'VSS', 'VDD', 'VDDIO', 'VCCA', 'VREF+', '+3V3', '+1V8', '3V3', 'VBAT', 'NC'])
		ok(isIgnoredNet(n, DEFAULT_CONFIG), `网络名忽略：${n}`);
	for (const n of ['KEY1', 'I2C1_SCL', 'MY_RAIL', 'USB_DP', 'NRST', 'TDI'])
		ok(!isIgnoredNet(n, DEFAULT_CONFIG), `信号不忽略：${n}`);
	ok(!isIgnoredNet('GND', cfgOf({ ignorePower: false })), 'ignorePower 关闭时 GND 不忽略');
	for (const n of ['1V5', '1V0', '12V', '3.3V', '2V5', '-12V'])
		ok(isIgnoredNet(n, DEFAULT_CONFIG), `电压形态归电源：${n}`);
	for (const n of ['EXTV', 'V5', '5V_UART', 'DDR_VREF'])
		ok(!isIgnoredNet(n, DEFAULT_CONFIG), `非裸电压不误伤：${n}`);
	ok(isIgnoredNet('PWR_EN', cfgOf({ ignoreNets: 'PWR*' })), '自定义名单通配生效');
	ok(!isIgnoredNet('GND', cfgOf({ ignoreNets: '' })), '空名单');

	for (const p of ['VDD', 'VDDIO', 'VSS', 'VSSA', 'VCC', 'GND', 'AGND', 'VBAT', 'VREF+', 'EP', 'PAD', 'NC', 'N.C.'])
		ok(isPowerPinName(p), `引脚名电源：${p}`);
	for (const p of ['BOOT0', 'NRST', 'XTAL1', 'TDI', 'PC13', 'USB_DP', 'ADC_IN0', 'PA0'])
		ok(!isPowerPinName(p), `引脚名非电源：${p}`);
}

/* ================= 4. 位号工具 ================= */
function test04(): Promise<void> {
	console.log('· 位号工具与自然排序');
	eq(baseDesignator('U1A'), 'U1', '基准位号 U1A');
	eq(baseDesignator('U12B'), 'U12', '基准位号 U12B');
	eq(baseDesignator('RN1'), 'RN1', '无后缀原样');
	eq(baseDesignator('FID1'), 'FID1', '字母开头无后缀原样');

	ok(naturalCompare('U2', 'U10') < 0, '自然排序 U2 < U10');
	ok(naturalCompare('R1', 'R2') < 0, 'R1 < R2');
	ok(naturalCompare('PIN2', 'PIN10') < 0, 'PIN2 < PIN10');
	ok(naturalCompare('J1', 'U1') < 0, '字母序 J < U');
	eq(naturalCompare('U1', 'U1'), 0, '相等返回 0');
	eq(pinRefLabel({ designator: 'U5', pinNumber: '6', pinName: 'SCL' }), 'U5.SCL(6)', '引脚名引用带引脚号');
	eq(pinTypeShort('IN'), 'I', '方向 IN -> I');
	eq(pinTypeShort('OUT'), 'O', '方向 OUT -> O');
	eq(pinTypeShort('BI'), 'IO', '方向 BI -> IO');
	eq(pinTypeShort('Power'), 'P', '方向 Power -> P');
	eq(pinTypeShort('Ground'), 'G', '方向 Ground -> G');
	eq(pinTypeShort('Undefined'), '', 'Undefined 不标方向');
	eq(pinTypeShort(undefined), '', '未设置不标方向');
	eq(pinRefLabel({ designator: 'R4', pinNumber: '1', pinName: '1' }), 'R4.1', '引脚名=引脚号用编号');
	eq(pinRefLabel({ designator: 'J1', pinNumber: '3', pinName: '' }), 'J1.3', '无引脚名用编号');
}

/* ================= 5. 核心器件解析 ================= */
function test05(): Promise<void> {
	console.log('· 核心器件解析（选中 ∪ 配置 ∪ 自动识别）');
	const snap = buildSnapshot();
	{
		const r = resolveCores(snap, cfgOf(), ['U1']);
		eq(r.cores.map(c => c.designator).join(','), 'U1', '选中器件');
		eq(r.missing.length, 0, '无缺失');
		ok(!r.autoUsed, '未用自动识别');
	}
	{
		const r = resolveCores(snap, cfgOf({ coreDesignators: 'u5,U2' }), []);
		eq(r.cores.map(c => c.designator).join(','), 'U2,U5', '配置位号（忽略大小写，自然排序）');
	}
	{
		const r = resolveCores(snap, cfgOf({ coreDesignators: 'U1' }), ['U1', 'u1']);
		eq(r.cores.length, 1, '并集去重');
	}
	{
		const r = resolveCores(snap, cfgOf(), ['X7', 'U1']);
		eq(r.missing.join(','), 'X7', '缺失位号上报');
	}
	{
		const r = resolveCores(snap, cfgOf(), ['X7']);
		eq(r.cores.length, 0, '全部缺失 -> 空');
	}
	{
		const r = resolveCores(snap, cfgOf(), []);
		eq(r.cores.length, 0, '无选中无配置且未开自动识别 -> 空');
	}
	{
		const r = resolveCores(snap, cfgOf({ autoDetectCore: true, autoDetectMinPins: 5 }), []);
		eq(r.cores.map(c => c.designator).join(','), 'U1,U2,U5', '自动识别 ≥5 脚（J1 4 脚被排除）');
		ok(r.autoUsed, '自动识别标记');
	}
	{
		const r = resolveCores(snap, cfgOf({ autoDetectCore: true, autoDetectMinPins: 4 }), []);
		eq(r.cores.map(c => c.designator).join(','), 'J1,U1,U2,U5', '自动识别 ≥4 脚按位号排序');
	}
}

/* ================= 6. 连接模型 ================= */
function test06(): Promise<void> {
	console.log('· 连接模型构建');
	const snap = buildSnapshot();
	const cfg = cfgOf();
	const idx = buildNetIndex(snap, cfg);

	{
		const st = netStats(idx);
		eq(st.netCount, 9, '网络总数');
		eq(st.signalNetCount, 6, '信号网络数');
		eq(st.powerNetCount, 3, '电源网络数');
		eq(st.unmatchedMembers, 0, '全部匹配');
	}
	eq(signalNets(idx).map(n => n.name).join(','), 'I2C1_SCL,I2C1_SDA,KEY1,NA1,NAY,RESET', '信号网络排序');
	eq(powerNets(idx).map(n => n.name).join(','), '+3V3,GND,MY_RAIL', '电源网络排序（含全电源脚自定义轨）');

	const u1 = snap.components.find(c => c.designator === 'U1')!;
	const rows = buildCorePinRows(u1, idx, cfg);
	const byPin = new Map(rows.map(r => [r.pinNumber, r]));
	eq(byPin.get('2')!.cls, 'signal', 'PC13 信号');
	eq(byPin.get('2')!.peers.map(pinRefLabel).join(', '), 'R3.1, SW1.1', 'PC13 对端（排序+排除自身）');
	eq(byPin.get('42')!.peers.map(pinRefLabel).join(', '), 'J1.SCL(3), R4.1, U5.SCL(6)', 'PB8 对端（引脚名+引脚号）');
	eq(byPin.get('5')!.peers.length, 0, '单成员网络对端为空');
	eq(byPin.get('1')!.cls, 'unconnected', 'VBAT 未连接');
	eq(byPin.get('3')!.noConnect, true, 'PC14 No ERC 标记');
	eq(byPin.get('23')!.cls, 'power', 'VSS@GND 电源（网络名）');
	eq(byPin.get('24')!.cls, 'power', 'VDD@+3V3 电源（网络名）');
	eq(byPin.get('25')!.cls, 'power', 'VDDIO@MY_RAIL 电源（引脚名兜底）');
	ok(byPin.get('25') !== undefined && byPin.get('25')!.net === 'MY_RAIL', 'VDDIO 网络名保留');

	// powerByPinName 关闭：VDDIO 变信号
	const idx2 = buildNetIndex(snap, cfgOf({ powerByPinName: false }));
	const rows2 = buildCorePinRows(u1, idx2, cfgOf({ powerByPinName: false }));
	eq(rows2.find(r => r.pinNumber === '25')!.cls, 'signal', '关引脚名判定后 VDDIO 为信号');

	// 多子部件：U2 聚合 + 网表 U2A/U2B 形态匹配 + 自身排除
	const u2 = snap.components.find(c => c.designator === 'U2')!;
	const u2rows = buildCorePinRows(u2, idx, cfg);
	const y1 = u2rows.find(r => r.pinNumber === '3')!;
	eq(y1.cls, 'signal', 'U2 Y1 信号');
	eq(y1.peers.map(pinRefLabel).join(', '), 'U2B.A2(4)', 'U2A-3 对端为另一门的 U2B-4（排除自身形态）');
	eq(u2rows.find(r => r.pinNumber === '1')!.net, 'NA1', '子部件形态网表匹配');
	eq(u2rows.find(r => r.pinNumber === '4')!.net, 'NAY', 'B 部件引脚匹配');

	// 未匹配成员
	const snap2 = { projectName: 'X', components: [u1], nets: [{ name: 'ORPHAN', members: [{ designator: 'X99', pinNumber: '1' }, { designator: 'U1', pinNumber: '2' }] }] };
	const idx3 = buildNetIndex(snap2, cfg);
	eq(idx3.unmatched.join(','), 'X99-1@ORPHAN', '未匹配成员明细');

	// 器件信号连接枚举
	const u5 = snap.components.find(c => c.designator === 'U5')!;
	deepEq(componentSignalPins(u5, idx, cfg).map(s => `${s.pinName}:${s.net}`), ['SDA:I2C1_SDA', 'SCL:I2C1_SCL'], 'U5 信号连接（电源与未连接剔除）');
	deepEq(componentSignalPins(u2, idx, cfg).map(s => `${s.pinName}:${s.net}`), ['A1:NA1', 'Y1:NAY', 'A2:NAY'], 'U2 信号连接');
	const r3 = snap.components.find(c => c.designator === 'R3')!;
	deepEq(componentSignalPins(r3, idx, cfg).map(s => `${s.pinNumber}:${s.net}`), ['1:KEY1'], 'R3 仅一脚信号');

	const cores = resolveCores(snap, cfg, ['U1']);
	const coreComps = buildCoreComponents(cores.cores, idx, cfg);
	eq(coreComps.length, 1, '核心渲染单元数');
	const touched = netsTouchingCores(coreComps);
	eq(touched.size, 7, '核心涉及网络数');
	ok(touched.has('KEY1') && touched.has('GND') && touched.has('MY_RAIL'), '核心网络集合含信号与电源');
	eq(coreComps[0].model, 'STM32F103C8T6', '核心型号');
	eq(coreComps[0].manufacturer, 'ST', '核心制造商');
	eq(coreComps[0].footprint, 'LQFP48', '核心封装');
}

/* ================= 7. Markdown 渲染（紧凑风格默认） ================= */
function test07(): Promise<void> {
	console.log('· Markdown 渲染（紧凑风格默认）');
	const snap = buildSnapshot();
	const cfg = cfgOf();
	const idx = buildNetIndex(snap, cfg);
	const { cores } = resolveCores(snap, cfg, ['U1']);
	const coreComps = buildCoreComponents(cores, idx, cfg);
	const rendered = renderMarkdown(snap, cfg, coreComps, idx, { now: new Date(2026, 8, 17, 9, 5) });
	const md = rendered.markdown;

	includes(md, '# 电路连接导出：DemoBoard', '标题');
	includes(md, '2026-09-17 09:05 · 器件 7（核心 1）· 网络 9（信号 6 + 电源 3，已忽略）', '元信息行');
	includes(md, '> 记法：连接点 = 位号.引脚名(引脚号)', '记法说明行');
	includes(md, '### U1 — STM32F103C8T6（ST / LQFP48）', '核心器件标题（型号+厂商+封装）');
	includes(md, '共 12 引脚：信号 4 · 电源 5（已忽略）· 未连接 3', '引脚统计行');
	ok(md.includes('```text'), '紧凑风格使用代码块');
	includes(md, '2 PC13 KEY1 = R3.1, SW1.1', '信号引脚行');
	includes(md, '42 PB8 I2C1_SCL = J1.SCL(3), R4.1, U5.SCL(6)', '对端带引脚名+引脚号');
	includes(md, '43 PB9 I2C1_SDA = J1.SDA(4), U5.SDA(5)', 'SDA 对端');
	includes(md, '5 NRST RESET = -', '单成员网络空对端');
	ok(!/\n1 VBAT /.test(md), '电源/未连接脚不进引脚清单');
	includes(md, '未连接（3）：1 VBAT，3 PC14(NoERC)，4 PC15', '未连接行（含 No ERC）');
	includes(md, '电源（已忽略，5）：23 VSS，24 VDD，25 VDDIO，47 VDDA，48 VSS', '电源脚汇总行');
	includes(md, '## 2. 不经过核心器件的信号网络（2 个，核心相关网络已完整列在各核心器件表中）', '网络清单标题（自动范围）');
	includes(md, 'NA1: U2A.A1(1)', '网络行 NA1');
	includes(md, 'NAY: U2A.Y1(3), U2B.A2(4)', '多子部件网络行带引脚号');
	ok(!md.includes('KEY1: ') && !md.includes('I2C1_SCL: '), '核心相关网络不重复罗列');
	includes(md, '## 3. 其它器件一览（6 个）', '器件一览标题');
	includes(md, 'U5 AT24C02: SDA(5)=I2C1_SDA SCL(6)=I2C1_SCL', 'U5 行');
	includes(md, 'R3 10k: 1=KEY1', 'R3 行（型号/值）');
	includes(md, 'U2 74HC00: A1(1)=NA1 Y1(3)=NAY A2(4)=NAY', 'U2 行');
	includes(md, 'J1 CONN-01X4: SCL(3)=I2C1_SCL SDA(4)=I2C1_SDA', 'J1 行');
	includes(md, '## 4. 已忽略的电源/地网络（3 个）', '电源汇总标题');
	includes(md, 'GND(5): J1.GND(1), SW1.2, U1.VSS(23), U1.VSS(48), U5.GND(4)', 'GND 汇总行');
	includes(md, '+3V3(6): J1.VCC(2), R3.2, R4.2, U1.VDD(24), U1.VDDA(47), U5.VCC(8)', '+3V3 汇总行');
	includes(md, 'MY_RAIL(1): U1.VDDIO(25)', '自定义电源轨归入电源汇总');
	includes(md, 'lceda-sch-conn-export', '页脚');
	includes(md, '\n\n---\n\n*导出于', '页脚分隔线前有空行（避免 Setext 标题化）');
	ok(md.endsWith('\n') && !md.endsWith('\n\n'), '单换行结尾');

	const st = rendered.stats;
	eq(st.componentCount, 7, '统计：器件数');
	eq(st.coreCount, 1, '统计：核心数');
	eq(st.netCount, 9, '统计：网络数');
	eq(st.signalNetCount, 6, '统计：信号网络');
	eq(st.powerNetCount, 3, '统计：电源网络');
	eq(st.coreSignalPins, 4, '统计：核心信号脚');
	eq(st.corePowerPins, 5, '统计：核心电源脚');
	eq(st.coreUnconnectedPins, 3, '统计：核心未连接脚');
	eq(st.unmatchedMembers, 0, '统计：未匹配数');
	eq(rendered.unmatched.length, 0, '未匹配明细');

	includes(summaryText(st), '网络 9 个：信号 6，电源/忽略 3', '汇总文本网络行');
	includes(summaryText({ ...st, unmatchedMembers: 3 }), '3 个网表连接点未匹配', '汇总文本未匹配警告');
}
function test08(): Promise<void> {
	console.log('· Markdown 渲染（表格风格与配置开关）');
	const snap = buildSnapshot();
	const render = (cfg: ReturnType<typeof cfgOf>) => {
		const idx = buildNetIndex(snap, cfg);
		const { cores } = resolveCores(snap, cfg, ['U1']);
		return renderMarkdown(snap, cfg, buildCoreComponents(cores, idx, cfg), idx, { now: new Date(2026, 8, 17) }).markdown;
	};

	// 表格风格（第二风格，形态与旧版一致但对端带引脚号）
	const tbl = render(cfgOf({ outputStyle: 'table', netSectionScope: 'all' }));
	includes(tbl, '| 引脚号 | 引脚名 | 网络 | 连接到 |', '表格表头');
	includes(tbl, '| 42 | PB8 | I2C1_SCL | J1.SCL(3), R4.1, U5.SCL(6) |', '表格引脚行');
	includes(tbl, '未连接引脚（3）：1 (VBAT)、3 (PC14，No ERC)、4 (PC15)', '表格未连接行');
	includes(tbl, '电源/地引脚（已忽略，5）：23 (VSS)、24 (VDD)、25 (VDDIO)、47 (VDDA)、48 (VSS)', '表格电源行');
	includes(tbl, '| I2C1_SCL | J1.SCL(3), R4.1, U1.PB8(42), U5.SCL(6) |', '表格网络行');
	includes(tbl, '| U5 | AT24C02 | SDA:I2C1_SDA, SCL:I2C1_SCL |', '表格器件行');

	// 网络总表范围：all
	const all = render(cfgOf({ netSectionScope: 'all' }));
	includes(all, '## 2. 信号网络总表（6 个）', '范围 all 标题');
	includes(all, 'KEY1: R3.1, SW1.1, U1.PC13(2)', '范围 all 含核心相关网络');

	// 引脚方向标注
	const dir = render(cfgOf({ showPinType: true }));
	includes(dir, '2 PC13[I] KEY1 = R3.1, SW1.1', '引脚方向 [I]');
	ok(dir.includes('42 PB8 I2C1_SCL'), 'Undefined 方向不标注');
	includes(dir, '引脚名后方括号为电气方向', '记法行说明方向');

	// 章节开关
	ok(!render(cfgOf({ includeNetSection: false })).includes('## 2.'), '关闭网络清单');
	ok(!render(cfgOf({ includeComponentsSection: false })).includes('## 3.'), '关闭器件一览');
	ok(!render(cfgOf({ includePowerSummary: false })).includes('## 4.'), '关闭电源汇总');
	ok(!render(cfgOf({ showUnconnected: false })).includes('未连接（'), '关闭未连接行');

	// ignorePower 关闭（配 all 才能在网络清单看到电源）
	const keepPower = render(cfgOf({ ignorePower: false, netSectionScope: 'all' }));
	includes(keepPower, '电源 0，保留）', 'ignorePower 关闭元信息');
	includes(keepPower, '+3V3: J1.VCC(2), R3.2, R4.2, U1.VDD(24), U1.VDDA(47), U5.VCC(8)', '电源网络进入网络清单');
	includes(keepPower, '电源（按引脚名归类，5）', '电源脚行文案切换');
	ok(!keepPower.includes('## 4. 已忽略'), 'ignorePower 关闭无汇总章节');

	// 核心器件换成 U5：型号/对端/范围联动
	const cfgU5 = cfgOf();
	const idxU5 = buildNetIndex(snap, cfgU5);
	const u5res = resolveCores(snap, cfgU5, ['U5']);
	const mdU5 = renderMarkdown(snap, cfgU5, buildCoreComponents(u5res.cores, idxU5, cfgU5), idxU5, { now: new Date(2026, 0, 1) }).markdown;
	includes(mdU5, '### U5 — AT24C02（SOIC-8）', 'U5 为核心');
	includes(mdU5, '5 SDA I2C1_SDA = J1.SDA(4), U1.PB9(43)', 'U5 SDA 对端');
	includes(mdU5, 'U1 STM32F103C8T6: PC13(2)=KEY1 NRST(5)=RESET PB8(42)=I2C1_SCL PB9(43)=I2C1_SDA', 'U1 进入其它器件行（型号+信号）');
	includes(mdU5, 'KEY1: R3.1, SW1.1, U1.PC13(2)', '核心切换后网络范围联动（KEY1 不再经过核心）');

	// 竖线转义（表格风格；紧凑风格在代码块内无需转义）
	const pipeCfg = cfgOf({ outputStyle: 'table', netSectionScope: 'all' });
	const snapPipe = { ...snap, nets: [...snap.nets, { name: 'A|B', members: [{ designator: 'U1', pinNumber: '2' }] }] };
	const idxPipe = buildNetIndex(snapPipe, pipeCfg);
	const { cores } = resolveCores(snapPipe, pipeCfg, ['U1']);
	const mdPipe = renderMarkdown(snapPipe, pipeCfg, buildCoreComponents(cores, idxPipe, pipeCfg), idxPipe, { now: new Date(2026, 0, 1) }).markdown;
	includes(mdPipe, '| A\\|B | U1.PC13(2) |', '竖线转义');
}
function test09(): Promise<void> {
	console.log('· Markdown 工具函数');
	eq(formatTimestamp(new Date(2026, 8, 17, 9, 5)), '2026-09-17 09:05', '时间戳补零');
	eq(formatTimestamp(new Date(2026, 11, 31, 23, 59)), '2026-12-31 23:59', '时间戳月末');
	eq(defaultFileName(cfgOf(), new Date(2026, 8, 17)), 'schematic-connections-20260917.md', '默认文件名');
	eq(defaultFileName(cfgOf({ filePrefix: 'demo' }), new Date(2026, 0, 2)), 'demo-20260102.md', '自定义前缀');
	eq(defaultFileName(cfgOf({ filePrefix: 'a/b:c*?"<>|d' }), new Date(2026, 0, 2)), 'abcd-20260102.md', '非法字符剔除');
	eq(defaultFileName(cfgOf({ filePrefix: '' }), new Date(2026, 0, 2)), 'schematic-connections-20260102.md', '空前缀回退默认');
}

/* ================= 8. 适配层 ================= */
function test10(): Promise<void> {
	console.log('· 适配层：多子部件聚合');
	const merged = aggregateComponents([
		{ designator: 'U2', model: '74HC00', subParts: ['A'], pins: [{ pinNumber: '1', pinName: 'A1', noConnect: false }, { pinNumber: '2', pinName: 'B1', noConnect: false }, { pinNumber: '3', pinName: 'Y1', noConnect: false }] },
		{ designator: 'U2', model: '74HC00', subParts: ['B'], pins: [{ pinNumber: '4', pinName: 'A2', noConnect: false }, { pinNumber: '5', pinName: 'B2', noConnect: false }, { pinNumber: '6', pinName: 'Y2', noConnect: false }, { pinNumber: '3', pinName: 'Y1', noConnect: false }] },
		{ designator: 'U1', model: 'MCU', subParts: [], pins: [{ pinNumber: '1', pinName: 'VDD', noConnect: false }] },
	]);
	eq(merged.length, 2, '聚合后器件数');
	eq(merged[0].pins.length, 6, '引脚按编号去重');
	deepEq(merged[0].subParts, ['A', 'B'], '子部件合并');
	eq(merged[1].designator, 'U1', '聚合保持出现顺序');
}

async function test11(): Promise<void> {
	console.log('· 适配层：配置存取');
	const { storage } = installEdaMock();
	eq(loadConfig().ignorePower, true, '空存储 -> 默认配置');
	storage.set('schConnExportConfig', 'not-json');
	eq(loadConfig().filePrefix, 'schematic-connections', '脏存储 -> 默认配置');
	storage.set('schConnExportConfig', JSON.stringify({ coreDesignators: 'U1,U2', ignorePower: false, autoDetectMinPins: 'x', includeNetSection: 0 }));
	const cfg = loadConfig();
	eq(cfg.coreDesignators, 'U1,U2', '读取已存位号');
	eq(cfg.ignorePower, false, '读取布尔');
	eq(cfg.autoDetectMinPins, 24, '非法数字回默认');
	eq(cfg.includeNetSection, false, '0 视为 false');
	eq(cfg.autoDetectCore, false, '仅 true 为真');

	const custom = cfgOf({ coreDesignators: 'U3', ignoreNets: 'GND,PWR*', filePrefix: 'board' });
	const saveLoop = async () => {
		ok(await saveConfig(custom), 'saveConfig 返回成功');
		const back = loadConfig();
		eq(back.coreDesignators, 'U3', '配置回读位号');
		eq(back.ignoreNets, 'GND,PWR*', '配置回读名单');
		eq(back.filePrefix, 'board', '配置回读前缀');
	};
	await saveLoop();
}

async function test12(): Promise<void> {
	console.log('· 适配层：导出内容缓存');
	const { storage } = installEdaMock();
	await storeLastExport('# hello\ncontent', 'demo.md');
	const last = loadLastExport();
	ok(!!last, '导出缓存存在');
	eq(last!.markdown, '# hello\ncontent', '导出缓存内容');
	eq(last!.fileName, 'demo.md', '缓存携带文件名');
	eq(last!.truncated, false, '未截断');
	ok(last!.ts > 0, '时间戳');
	storage.delete('schConnExportLast');
	eq(loadLastExport(), undefined, '无缓存 -> undefined');
}

async function test13(): Promise<void> {
	console.log('· 适配层：选中位号提取');
	installEdaMock({ selectedComps: [{ designator: 'U1' }, { designator: 'U5' }, { designator: 'U1' }] });
	deepEq(await getSelectedDesignators(), ['U1', 'U5'], '选中器件位号去重');

	// 只选引脚 -> 反查父器件
	installEdaMock({
		selectedPins: [{ id: 'pin-u2-3' }],
		allComps: [
			{ id: 'u1', designator: 'U1', model: 'MCU', pins: [{ number: '1', name: 'VDD' }] },
			{ id: 'u2', designator: 'U2A', subPart: 'A', model: '74HC00', pins: [{ number: '3', name: 'Y1' }] },
		],
	});
	deepEq(await getSelectedDesignators(), ['U2A'], '选中引脚反查父器件');
}

async function test14(): Promise<void> {
	console.log('· 适配层：整图快照收集');
	installEdaMock({
		projectName: 'P1',
		netlistText: buildProtel2Text(),
		allComps: [
			{ id: 'u1', designator: 'U1', model: 'STM32', footprint: 'LQFP48', pins: [{ number: '2', name: 'PC13' }, { number: '24', name: 'VDD' }] },
			{ id: 'u2a', designator: 'U2A', subPart: 'A', model: '74HC00', pins: [{ number: '1', name: 'A1' }, { number: '3', name: 'Y1' }] },
			{ id: 'u2b', designator: 'U2B', subPart: 'B', model: '74HC00', pins: [{ number: '4', name: 'A2' }, { number: '6', name: 'Y2' }] },
		],
	});
	const snap = await (await import('../src/eda-adapter.ts')).collectSnapshot();
	eq(snap.projectName, 'P1', '工程名');
	eq(snap.components.length, 2, '多子部件聚合为 2 个器件');
	eq(snap.components[1].designator, 'U2', '聚合基准位号');
	eq(snap.components[1].pins.length, 4, '聚合引脚数');
	deepEq(snap.components[1].subParts, ['A', 'B'], '聚合子部件');
	eq(snap.components[0].model, 'STM32', '型号（制造商编号优先）');
	eq(snap.components[0].footprint, 'LQFP48', '封装');
	eq(snap.nets.length, 5, '网表解析');

	// 网表缺失 -> 空网络不炸
	installEdaMock({ allComps: [{ id: 'u1', designator: 'U1', model: 'X', pins: [] }] });
	const snap2 = await (await import('../src/eda-adapter.ts')).collectSnapshot();
	eq(snap2.nets.length, 0, '空网表');
	eq(snap2.projectName, '', '工程名缺省');
}

async function test15(): Promise<void> {
	console.log('· 适配层：网表多源回退与型号清洗');
	const one = [{ id: 'u1', designator: 'U1', model: 'X', pins: [{ number: '2', name: 'PC13' }] as any }];

	// 1) 字符串网表接口返回空 -> 回退 sch_ManufactureData.getNetlistFile
	installEdaMock({ projectName: 'P2', netlistText: '', netlistFileText: buildProtel2Text(), allComps: one });
	const s1 = await collectSnapshot();
	eq(s1.nets.length, 5, '回退 getNetlistFile 后网表解析成功');
	eq(s1.netlistEmpty, false, 'netlistEmpty=false');

	// 2) 两路都为空 -> netlistEmpty 标记
	installEdaMock({ netlistText: '', allComps: one });
	const s2 = await collectSnapshot();
	eq(s2.nets.length, 0, '两路皆空 -> 0 网络');
	eq(s2.netlistEmpty, true, 'netlistEmpty=true');
	// 文档头部出现醒目告警
	const cfg2 = cfgOf();
	const idx2 = buildNetIndex(s2, cfg2);
	const { cores: cores2 } = resolveCores(s2, cfg2, ['U1']);
	const md2 = renderMarkdown(s2, cfg2, buildCoreComponents(cores2, idx2, cfg2), idx2, { now: new Date(2026, 0, 1) }).markdown;
	includes(md2, '网表读取为空', '空网表时文档头告警');
	includes(md2, '不代表真实电路', '空网表告警措辞');

	// 3) 字符串接口返回 Blob/File 形态 -> 也能解析
	installEdaMock({ netlistAsBlob: true, netlistText: buildProtel2Text(), allComps: one });
	const s3 = await collectSnapshot();
	eq(s3.nets.length, 5, 'Blob 形态网表可解析');
	eq(s3.netlistEmpty, false, 'Blob 形态 netlistEmpty=false');

	// 4) 型号清洗：={Value} 模板跳过，取自定义属性 Value
	installEdaMock({
		netlistText: '',
		allComps: [
			{ id: 'c9', designator: 'C9', name: '={Value}', other: { Value: '100nF' }, pins: [{ number: '1', name: '1' }, { number: '2', name: '2' }] },
			{ id: 'c10', designator: 'C10', name: '={Value}', pins: [{ number: '1', name: '1' }, { number: '2', name: '2' }] },
		],
	});
	const s4 = await collectSnapshot();
	eq(s4.components.find(c => c.designator === 'C9')!.model, '100nF', '模板占位跳过取自定义 Value');
	eq(s4.components.find(c => c.designator === 'C10')!.model, '', '全部为模板时型号为空（渲染为 ?）');

	// 5) R/C/L 位号值优先：料号让位给值（470nF/10k/1uH），无值退回料号，IC 保持料号优先
	installEdaMock({
		netlistText: '',
		allComps: [
			{ id: 'c8', designator: 'C8', manufacturerId: 'HGC0402R5106M100NTEJ', name: '={Value}', other: { Value: '470nF' }, pins: [{ number: '1', name: '1' }, { number: '2', name: '2' }] },
			{ id: 'r7', designator: 'R7', manufacturerId: 'RC0402FR-0710KL', name: '10k', pins: [{ number: '1', name: '1' }, { number: '2', name: '2' }] },
			{ id: 'l1', designator: 'L1', manufacturerId: 'SWPA8040S1R0MT', other: { Value: '1uH' }, pins: [{ number: '1', name: '1' }, { number: '2', name: '2' }] },
			{ id: 'c11', designator: 'C11', manufacturerId: 'CL10B104KB8NNNC', name: '={Value}', pins: [{ number: '1', name: '1' }, { number: '2', name: '2' }] },
			{ id: 'u9', designator: 'U9', manufacturerId: 'CH32H417WEU6', name: '={Value}', other: { Value: 'MCU' }, pins: [{ number: '1', name: 'VDD' }] },
		],
	});
	const s5 = await collectSnapshot();
	eq(s5.components.find(c => c.designator === 'C8')!.model, '470nF', 'C 有值显示 470nF 而非料号');
	eq(s5.components.find(c => c.designator === 'R7')!.model, '10k', 'R 值在名称属性时取 10k');
	eq(s5.components.find(c => c.designator === 'L1')!.model, '1uH', 'L 电感同为值优先');
	eq(s5.components.find(c => c.designator === 'C11')!.model, 'CL10B104KB8NNNC', 'R/C/L 无值时退回料号');
	eq(s5.components.find(c => c.designator === 'U9')!.model, 'CH32H417WEU6', 'IC 保持料号优先');
}

async function test16(): Promise<void> {
	console.log('· 几何法网络重建');
	// 电路：U1(PC13/GND域, NRST/RESET, PB8/I2C1_SCL) + R3(1=GND, 2=NetR3_2) + U5(SCL=NetR3_2) + R4(1=I2C1_SCL)
	const comps = [
		{ id: 'u1', designator: 'U1', model: 'MCU', pins: [
			{ number: '2', name: 'PC13', x: 100, y: 100 },
			{ number: '5', name: 'NRST', x: 200, y: 100 },
			{ number: '42', name: 'PB8', x: 500, y: 100 },
		] },
		{ id: 'r3', designator: 'R3', model: '10k', pins: [
			{ number: '1', name: '1', x: 100, y: 200 },
			{ number: '2', name: '2', x: 300, y: 200 },
		] },
		{ id: 'u5', designator: 'U5', model: 'EEPROM', pins: [
			{ number: '6', name: 'SCL', x: 400, y: 100 },
		] },
		{ id: 'r4', designator: 'R4', model: '4.7k', pins: [
			{ number: '1', name: '1', x: 500, y: 300 },
		] },
	];
	installEdaMock({
		netlistText: '',
		allComps: comps,
		wires: [
			{ line: [100, 100, 100, 150, 100, 200] }, // 折线：U1.2 - R3.1（无名，靠 GND 标识命名）
			{ net: 'RESET', line: [200, 100, 250, 100] }, // 导线自带网络名
			{ line: [300, 200, 400, 200, 400, 100] }, // R3.2 - U5.6（无名 -> 自动名）
			{ id: 'w4', line: [500, 100, 500, 300] }, // U1.42 - R4.1（全局网络名映射）
		],
		netFlags: [{ x: 100, y: 150, net: 'GND' }],
		projectNets: [{ net: 'I2C1_SCL', wires: [{ id: 'w4' }] }],
	});
	const snap = await collectSnapshot();
	eq(snap.nets.length, 4, '几何法重建网络数');
	eq(snap.netlistEmpty, false, 'netlistEmpty=false（几何法兜底成功）');
	const byName = new Map(snap.nets.map(n => [n.name, n.members.map(m => `${m.designator}-${m.pinNumber}`).sort()]));
	deepEq(byName.get('GND'), ['R3-1', 'U1-2'], '网络标识命名簇（GND）');
	deepEq(byName.get('RESET'), ['U1-5'], '导线自带网络名（RESET）');
	deepEq(byName.get('NetR3_2'), ['R3-2', 'U5-6'], '自动命名簇（Net位号_引脚号）');
	deepEq(byName.get('I2C1_SCL'), ['R4-1', 'U1-42'], '全局网络名映射（sch_Net）');

	// 端到端：几何网络喂给渲染（GND 应归电源、I2C1_SCL 出现在核心表）
	const cfg = cfgOf();
	const idx = buildNetIndex(snap, cfg);
	const { cores } = resolveCores(snap, cfg, ['U1']);
	const coreComps = buildCoreComponents(cores, idx, cfg);
	const md = renderMarkdown(snap, cfg, coreComps, idx, { now: new Date(2026, 0, 1) }).markdown;
	includes(md, '5 NRST RESET = -', '几何网络进入核心表（RESET）');
	includes(md, '42 PB8 I2C1_SCL = R4.1', '几何网络对端（I2C1_SCL）');
	ok(!md.includes('网表读取为空'), '几何法成功时无空网表告警');
	ok(md.includes('电源（已忽略，1）：2 PC13'), 'GND 标识簇被电源过滤');

	// 引脚不在任何导线上 -> 未连接；无导线 -> 全未连接
	installEdaMock({ netlistText: '', allComps: comps, wires: [] });
	const snap2 = await collectSnapshot();
	eq(snap2.nets.length, 0, '无导线时几何法 0 网络');
	eq(snap2.netlistEmpty, true, 'netlistEmpty=true');
}

async function test17(): Promise<void> {
	console.log('· 同名网络合并（跨簇/跨页标签同名即同网）');
	// 两片互不相连的导线都打 DDR_DQ0 标签：U1 侧与 U2 侧
	const comps = [
		{ id: 'u1', designator: 'U1', model: 'FPGA', pins: [
			{ number: 'A2', name: 'IO_L2N', x: 100, y: 100 },
			{ number: 'A1', name: 'GND', x: 100, y: 500 },
		] },
		{ id: 'u2', designator: 'U2', model: 'DDR', pins: [
			{ number: 'H8', name: 'DQ0', x: 900, y: 900 },
		] },
		{ id: 'c1', designator: 'C1', model: '100nF', pins: [
			{ number: '1', name: '1', x: 100, y: 600 },
		] },
	];
	installEdaMock({
		netlistText: '',
		allComps: comps,
		wires: [
			{ net: 'DDR_DQ0', line: [100, 100, 150, 100] },
			{ net: 'DDR_DQ0', line: [900, 900, 950, 900] },
			{ line: [100, 500, 100, 600] }, // U1.A1(GND) - C1.1，无标签
		],
		netFlags: [{ x: 100, y: 550, net: 'GND' }],
	});
	const snap = await collectSnapshot();
	eq(snap.nets.length, 2, '两簇 DDR_DQ0 合并为一个网络');
	const dq0 = snap.nets.find(n => n.name === 'DDR_DQ0')!;
	deepEq(dq0.members.map(m => `${m.designator}-${m.pinNumber}`).sort(), ['U1-A2', 'U2-H8'], '合并后成员含两侧');

	// 端到端：FPGA 核心表里 DDR_DQ0 的对端出现 U2.DQ0
	const cfg = cfgOf();
	const idx = buildNetIndex(snap, cfg);
	const { cores } = resolveCores(snap, cfg, ['U1']);
	const md = renderMarkdown(snap, cfg, buildCoreComponents(cores, idx, cfg), idx, { now: new Date(2026, 0, 1) }).markdown;
	includes(md, 'A2 IO_L2N DDR_DQ0 = U2.DQ0(H8)', '跨簇同名合并后对端可见');
	includes(md, 'GND(2): C1.1, U1.GND(A1)', '同名 GND 簇合并进电源汇总');
}

async function test18(): Promise<void> {
	console.log('· 模块视图（选中器件互联）');
	const snap = buildSnapshot();
	const cfg = cfgOf();
	const idx = buildNetIndex(snap, cfg);
	// 选中 U1 + U5 + J1（MCU + EEPROM + 接口座）
	const { cores } = resolveCores(snap, cfg, ['U1', 'U5', 'J1']);
	eq(cores.length, 3, '选中 3 个器件解析成功');
	const doc = renderSelectionMarkdown(snap, cfg, buildCoreComponents(cores, idx, cfg), idx, { now: new Date(2026, 0, 1) });
	eq(doc.stats.selectedCount, 3, '选中器件数');
	eq(doc.stats.interconnectCount, 2, '互联网络数（I2C1_SCL/I2C1_SDA）');
	eq(doc.stats.boundaryCount, 2, '对外引脚数（KEY1/RESET）');
	eq(doc.stats.powerPinCount, 9, '电源脚数（U1 5 + U5 2 + J1 2）');
	eq(doc.stats.unconnectedPinCount, 7, '未连接数（U1 3 + U5 4）');
	includes(doc.markdown, '# 模块连接导出：DemoBoard（选中 3 个器件）', '标题含工程名与选中数');
	includes(doc.markdown, 'I2C1_SCL: J1.SCL(3) = U1.PB8(42) = U5.SCL(6)，外部：R4.1', '互联行（选中侧 = 连接，未选中侧外部标注）');
	includes(doc.markdown, 'I2C1_SDA: J1.SDA(4) = U1.PB9(43) = U5.SDA(5)', '纯选中互联行（无外部成员）');
	includes(doc.markdown, 'U1.PC13(2) KEY1 = R3.1, SW1.1', '对外引脚行（模块外去向）');
	includes(doc.markdown, 'U1.NRST(5) RESET = -', '对外引脚行（无对端为 -）');
	includes(doc.markdown, '## 1. 选定器件（3 个）', '选定器件清单章节');
	includes(doc.markdown, 'U1 STM32F103C8T6（ST / LQFP48） · 12 脚', '选定器件行（型号+引脚数）');
	includes(doc.markdown, 'U1：电源/地 5（已忽略）：23 VSS，24 VDD，25 VDDIO，47 VDDA，48 VSS · 未连接 3', '电源/未连接汇总行');
	ok(!doc.markdown.includes('74HC00'), '未选中器件（U2）不出现在模块视图');
	ok(!doc.markdown.includes('MY_RAIL'), '被忽略电源轨不出现（只显示引脚名）');

	// 表格风格
	const cfgTable = cfgOf({ outputStyle: 'table' });
	const idxT = buildNetIndex(snap, cfgTable);
	const docT = renderSelectionMarkdown(snap, cfgTable, buildCoreComponents(cores, idxT, cfgTable), idxT, { now: new Date(2026, 0, 1) });
	includes(docT.markdown, '| 网络 | 选定器件连接点 | 外部连接点 |', '表格风格互联表头');
	includes(docT.markdown, '| U1.PC13(2) | KEY1 | R3.1, SW1.1 |', '表格风格对外行');

	// 电气方向标注（showPinType）
	const cfgDir = cfgOf({ showPinType: true });
	const idxD = buildNetIndex(snap, cfgDir);
	const docD = renderSelectionMarkdown(snap, cfgDir, buildCoreComponents(cores, idxD, cfgDir), idxD, { now: new Date(2026, 0, 1) });
	includes(docD.markdown, 'U1.PC13(2)[I] KEY1 = R3.1, SW1.1', '对外行带方向 [I]');

	// 空网表告警
	const snapEmpty: SchSnapshot = { ...snap, nets: [] };
	const idxE = buildNetIndex(snapEmpty, cfg);
	const docE = renderSelectionMarkdown(snapEmpty, cfg, buildCoreComponents(cores, idxE, cfg), idxE, { now: new Date(2026, 0, 1) });
	includes(docE.markdown, '网表读取为空', '空网表文档头告警');

	// 多子部件成员形态（U2A/U2B）归属到同一选中器件
	const snapSub: SchSnapshot = {
		projectName: 'Sub',
		components: [
			{ designator: 'U1', model: 'MCU', subParts: [], pins: [{ pinNumber: '1', pinName: 'TX', noConnect: false }] },
			{ designator: 'U2', model: 'DUAL', subParts: ['A', 'B'], pins: [
				{ pinNumber: '1', pinName: 'X', noConnect: false },
				{ pinNumber: '2', pinName: 'Y', noConnect: false },
			] },
			{ designator: 'R1', model: '10k', subParts: [], pins: [{ pinNumber: '1', pinName: '1', noConnect: false }] },
		],
		nets: [
			{ name: 'M', members: [{ designator: 'U1', pinNumber: '1' }, { designator: 'U2A', pinNumber: '1' }] },
			{ name: 'N', members: [{ designator: 'U2B', pinNumber: '2' }, { designator: 'R1', pinNumber: '1' }] },
		],
	};
	const idxSub = buildNetIndex(snapSub, cfg);
	const coresSub = resolveCores(snapSub, cfg, ['U1', 'U2']).cores;
	const docSub = renderSelectionMarkdown(snapSub, cfg, buildCoreComponents(coresSub, idxSub, cfg), idxSub, { now: new Date(2026, 0, 1) });
	eq(docSub.stats.interconnectCount, 1, 'U2A 成员归属选中器件 U2（与 U1 构成互联）');
	eq(docSub.stats.boundaryCount, 1, 'U2 另一脚为对外引脚');
	includes(docSub.markdown, 'M: U1.TX(1) = U2A.X(1)', '子部件成员按网表形态显示');
	includes(docSub.markdown, 'U2.Y(2) N = R1.1', '子部件器件的对外行');

	// 模块命令只认画布选中：不并入配置位号、不自动识别
	const res = resolveCores(snap, { ...cfgOf({ coreDesignators: 'U5' }), coreDesignators: '', autoDetectCore: false }, ['U1']);
	eq(res.cores.length, 1, '不并入配置位号');
	eq(res.cores[0].designator, 'U1', '仅画布选中的器件');

	// 电源脚明细：按引脚号自然排序 + 引脚名与引脚号相同只写一处（TVS 的 8 8 -> 8）
	const snapPw: SchSnapshot = {
		projectName: 'Pw',
		components: [{
			designator: 'D9',
			model: 'TVS',
			subParts: [],
			pins: [
				{ pinNumber: '8', pinName: '8', noConnect: false },
				{ pinNumber: '3', pinName: '3', noConnect: false },
			],
		}],
		nets: [{ name: 'GND', members: [{ designator: 'D9', pinNumber: '8' }, { designator: 'D9', pinNumber: '3' }] }],
	};
	const idxPw = buildNetIndex(snapPw, cfg);
	const coresPw = resolveCores(snapPw, cfg, ['D9']).cores;
	const docPw = renderSelectionMarkdown(snapPw, cfg, buildCoreComponents(coresPw, idxPw, cfg), idxPw, { now: new Date(2026, 0, 1) });
	includes(docPw.markdown, 'D9：电源/地 2（已忽略）：3，8', '模块视图电源脚排序+引脚名与号相同去重');
	ok(!docPw.markdown.includes('8 8'), '电源脚不再重复显示 8 8');
	ok(docPw.markdown.includes('· 模块视图*'), '文末斜体收尾无多余空格');
	const mdPw = renderMarkdown(snapPw, cfg, buildCoreComponents(coresPw, idxPw, cfg), idxPw, { now: new Date(2026, 0, 1) }).markdown;
	includes(mdPw, '电源（已忽略，2）：3，8', '全图导出电源脚同步去重');
}

/* ---------------- 主入口 ---------------- */

(async () => {
	test01();
	test02();
	test03();
	test04();
	test05();
	test06();
	test07();
	test08();
	test09();
	test10();
	await test11();
	await test12();
	await test13();
	await test14();
	await test15();
	await test16();
	await test17();
	await test18();

	console.log('');
	if (failures) {
		console.error(`✗ ${checks} 项断言，${failures} 项失败`);
		process.exit(1);
	}
	console.log(`✓ 全部 ${checks} 项断言通过`);
})();
