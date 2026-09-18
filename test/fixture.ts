import type { ExportConfig, RawComponent, SchSnapshot } from '../src/types.ts';
/**
 * 离线测试夹具 / Offline fixtures
 *
 * 构造一个小型演示电路快照：STM32(U1) + 24C02(U5) + 按键/上拉 +
 * 连接器(J1) + 双门 74HC00(U2, 多子部件 U2A/U2B)，
 * 覆盖电源网、自定义电源轨(MY_RAIL)、未连接脚、No ERC、多子部件匹配。
 */
import { DEFAULT_CONFIG } from '../src/types.ts';

export function cfgOf(over: Partial<ExportConfig> = {}): ExportConfig {
	return { ...DEFAULT_CONFIG, ...over };
}

function pin(pinNumber: string, pinName: string, noConnect = false, pinType?: string) {
	return { pinNumber, pinName, noConnect, pinType };
}

function comp(designator: string, model: string, pins: RawComponent['pins'], extra: Partial<RawComponent> = {}): RawComponent {
	return { designator, model, subParts: [], pins, ...extra };
}

/** 演示电路快照（U1 为核心器件） */
export function buildSnapshot(): SchSnapshot {
	const components: RawComponent[] = [
		comp('U1', 'STM32F103C8T6', [
			pin('1', 'VBAT'),
			pin('2', 'PC13', false, 'IN'),
			pin('3', 'PC14', true), // No ERC
			pin('4', 'PC15'),
			pin('5', 'NRST'),
			pin('23', 'VSS'),
			pin('24', 'VDD'),
			pin('25', 'VDDIO'), // 接自定义电源轨 MY_RAIL（网络名不在默认名单，靠引脚名判电源）
			pin('42', 'PB8', false, 'Undefined'),
			pin('43', 'PB9'),
			pin('47', 'VDDA'),
			pin('48', 'VSS'),
		], { manufacturer: 'ST', footprint: 'LQFP48' }),
		comp('U2', '74HC00', [
			pin('1', 'A1'),
			pin('2', 'B1'),
			pin('3', 'Y1'),
			pin('4', 'A2'),
			pin('5', 'B2'),
			pin('6', 'Y2'),
		], { subParts: ['A', 'B'] }),
		comp('U5', 'AT24C02', [
			pin('1', 'A0'),
			pin('2', 'A1'),
			pin('3', 'A2'),
			pin('4', 'GND'),
			pin('5', 'SDA'),
			pin('6', 'SCL'),
			pin('7', 'WP'),
			pin('8', 'VCC'),
		], { footprint: 'SOIC-8' }),
		comp('R3', '10k', [pin('1', '1'), pin('2', '2')]),
		comp('R4', '4.7k', [pin('1', '1'), pin('2', '2')]),
		comp('SW1', 'KEY-SMD', [pin('1', '1'), pin('2', '2')]),
		comp('J1', 'CONN-01X4', [pin('1', 'GND'), pin('2', 'VCC'), pin('3', 'SCL'), pin('4', 'SDA')]),
	];

	const nets: SchSnapshot['nets'] = [
		{ name: 'KEY1', members: [{ designator: 'U1', pinNumber: '2' }, { designator: 'R3', pinNumber: '1' }, { designator: 'SW1', pinNumber: '1' }] },
		{ name: 'RESET', members: [{ designator: 'U1', pinNumber: '5' }] },
		{ name: 'I2C1_SCL', members: [{ designator: 'U1', pinNumber: '42' }, { designator: 'U5', pinNumber: '6' }, { designator: 'R4', pinNumber: '1' }, { designator: 'J1', pinNumber: '3' }] },
		{ name: 'I2C1_SDA', members: [{ designator: 'U1', pinNumber: '43' }, { designator: 'U5', pinNumber: '5' }, { designator: 'J1', pinNumber: '4' }] },
		{ name: 'MY_RAIL', members: [{ designator: 'U1', pinNumber: '25' }] },
		{ name: '+3V3', members: [{ designator: 'U1', pinNumber: '24' }, { designator: 'U1', pinNumber: '47' }, { designator: 'U5', pinNumber: '8' }, { designator: 'R3', pinNumber: '2' }, { designator: 'R4', pinNumber: '2' }, { designator: 'J1', pinNumber: '2' }] },
		{ name: 'GND', members: [{ designator: 'U1', pinNumber: '23' }, { designator: 'U1', pinNumber: '48' }, { designator: 'U5', pinNumber: '4' }, { designator: 'SW1', pinNumber: '2' }, { designator: 'J1', pinNumber: '1' }] },
		// 多子部件：网表成员位号带 U2A/U2B 形态，画布聚合为 U2
		{ name: 'NA1', members: [{ designator: 'U2A', pinNumber: '1' }] },
		{ name: 'NAY', members: [{ designator: 'U2A', pinNumber: '3' }, { designator: 'U2B', pinNumber: '4' }] },
	];

	return { projectName: 'DemoBoard', components, nets };
}

/** 与 buildSnapshot 等价的 Protel2 网表文本（测网表解析路径用） */
export function buildProtel2Text(): string {
	return [
		'[',
		'U1',
		'LQFP48',
		'STM32F103C8T6',
		'',
		']',
		'(',
		'"KEY1"',
		'3',
		'U1-2',
		'R3-1',
		'SW1-1',
		')',
		'(',
		'I2C1_SCL',
		'4',
		'U1-42',
		'U5-6',
		'R4-1',
		'J1-3',
		')',
		'(',
		'+3V3',
		'6',
		'U1-24',
		'U1-47',
		'U5-8',
		'R3-2',
		'R4-2',
		'J1-2',
		')',
		'(',
		'GND',
		'5',
		'U1-23',
		'U1-48',
		'U5-4',
		'SW1-2',
		'J1-1',
		')',
		'(',
		'NAY',
		'2',
		'U2A-3',
		'U2B-4',
		')',
		'',
	].join('\r\n');
}

/* ---------------- eda 运行时 mock（适配层离线测试） ---------------- */

/** 简单状态图元 mock：按 map 取值 */
export function primMock(getters: Record<string, unknown>): any {
	return new Proxy({}, {
		get(_t, prop: string) {
			if (prop.startsWith('getState_')) {
				const key = prop.replace('getState_', '');
				return () => getters[key];
			}
			return undefined;
		},
	});
}

export interface EdaMockOptions {
	selectedComps?: Array<{ designator: string }>;
	selectedPins?: Array<{ id: string }>;
	allComps?: Array<{ id: string; designator: string; subPart?: string; model?: string; manufacturerId?: string; name?: string; other?: Record<string, string>; footprint?: string; pins: Array<{ number: string; name: string; noConnect?: boolean }> }>;
	netlistText?: string;
	/** sch_Netlist.getNetlist 以 Blob/File 形态返回 netlistText（模拟部分客户端行为） */
	netlistAsBlob?: boolean;
	/** sch_ManufactureData.getNetlistFile 返回的网表文本（备胎通道） */
	netlistFileText?: string;
	projectName?: string;
	/** 导线图元（几何法网络重建）：折线 [x1,y1,x2,y2,...] + 可选网络名/ID */
	wires?: Array<{ id?: string; net?: string; line: number[] }>;
	/** 网络标识（电源/地符号）位置与网络名 */
	netFlags?: Array<{ x: number; y: number; net: string }>;
	/** sch_Net.getCurrentProjectAllNets 返回的全局网络名（按导线 ID 映射） */
	projectNets?: Array<{ net: string; wires: Array<{ id: string; globalNetName?: string }> }>;
}

/** 构造 (globalThis).eda mock：选中/全器件/网表/存储/文件系统 */
export function installEdaMock(opts: EdaMockOptions = {}): {
	storage: Map<string, string>;
} {
	const storage = new Map<string, string>();

	const allCompPrims = (opts.allComps ?? []).map(c => primMock({
		PrimitiveType: 'Component',
		PrimitiveId: c.id,
		ComponentType: 'part',
		Designator: c.designator,
		SubPartName: c.subPart,
		ManufacturerId: c.manufacturerId ?? c.model,
		Name: c.name ?? c.model,
		OtherProperty: c.other,
		Footprint: c.footprint ? { name: c.footprint } : undefined,
	}));

	(globalThis as any).eda = {
		sys_Storage: {
			getExtensionUserConfig: (k: string) => storage.get(k),
			setExtensionUserConfig: async (k: string, v: string) => { storage.set(k, v); },
		},
		sch_SelectControl: {
			async getAllSelectedPrimitives() {
				return [
					...(opts.selectedComps ?? []).map(c => primMock({ PrimitiveType: 'Component', ComponentType: 'part', Designator: c.designator, PrimitiveId: `sel-${c.designator}` })),
					...(opts.selectedPins ?? []).map(p => primMock({ PrimitiveType: 'ComponentPin', PrimitiveId: p.id })),
				];
			},
		},
		sch_PrimitiveComponent: {
			async getAll(type?: string) {
				if (type === 'netflag') {
					return (opts.netFlags ?? []).map((fl, i) => primMock({
						PrimitiveType: 'Component',
						ComponentType: 'netflag',
						PrimitiveId: `flag-${i}`,
						Net: fl.net,
						X: fl.x,
						Y: fl.y,
					}));
				}
				return allCompPrims;
			},
			async getAllPinsByPrimitiveId(id: string) {
				const c = (opts.allComps ?? []).find(x => x.id === id);
				return (c?.pins ?? []).map(p => primMock({
					PrimitiveId: `pin-${id}-${p.number}`,
					PinNumber: p.number,
					PinName: p.name,
					NoConnected: p.noConnect === true,
					PinType: p.pinType,
					X: p.x,
					Y: p.y,
				}));
			},
		},
		sch_PrimitiveWire: {
			async getAll() {
				return (opts.wires ?? []).map((w, i) => primMock({
					PrimitiveId: w.id ?? `wire-${i}`,
					Net: w.net ?? '',
					Line: w.line,
				}));
			},
		},
		sch_Net: {
			async getCurrentProjectAllNets() {
				return opts.projectNets
					? [{ schematicName: 'S1', schematicUuid: 's1', boardName: 'B1', nets: opts.projectNets.map(n => ({ net: n.net, wires: n.wires.map(x => ({ id: x.id, globalNetName: x.globalNetName ?? n.net, pageName: 'P1', pageUuid: 'p1' })) })) }]
					: [];
			},
		},
		sch_Netlist: {
			async getNetlist() {
				const text = opts.netlistText ?? '';
				return opts.netlistAsBlob ? new Blob([text], { type: 'text/plain' }) : text;
			},
		},
		sch_ManufactureData: {
			async getNetlistFile() {
				return opts.netlistFileText !== undefined && opts.netlistFileText !== ''
					? new Blob([opts.netlistFileText], { type: 'text/plain' })
					: undefined;
			},
		},
		dmt_Project: {
			async getCurrentProjectInfo() {
				return opts.projectName ? { friendlyName: opts.projectName } : undefined;
			},
		},
	};
	return { storage };
}
