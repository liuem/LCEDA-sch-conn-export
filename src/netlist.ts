import type { RawNet } from './types.ts';
/**
 * Protel2 网表解析 / Protel2 netlist parser
 *
 * 数据来源：`eda.sch_Netlist.getNetlist('Protel2')` 返回的文本网表（工程级，
 * 覆盖全部图页）。格式：
 *   [
 *   U1
 *   器件封装
 *   8
 *
 *   ]
 *   (
 *   VCC
 *   2
 *   U1-8
 *   U2-8
 *   )
 *
 * 只关心 (...) 网络块：块内首行为网络名，其后 `位号-引脚号` 行为成员
 * （位号可含 '-'，引脚号取最后一个 '-' 之后；成员计数行/脏行自动忽略）。
 */

/** `位号\u0001引脚号` -> 网络名 */
export type PinNetMap = Map<string, string>;

export interface ParsedNetlist {
	/** 引脚 -> 网络 */
	pinNets: PinNetMap;
	/** 网络 -> 成员列表（按网表出现顺序） */
	nets: RawNet[];
}

export function pinKey(designator: string, pinNumber: string): string {
	return `${designator}\u0001${pinNumber}`;
}

export function parseProtel2Netlist(text: string): ParsedNetlist {
	const pinNets: PinNetMap = new Map();
	const nets: RawNet[] = [];
	if (!text || typeof text !== 'string')
		return { pinNets, nets };

	const lines = text.split(/\r?\n/).map(l => l.trim());
	let inNet = false;
	let netName = '';
	let members: Array<{ designator: string; pinNumber: string }> | undefined;

	const flush = () => {
		if (netName && members && members.length)
			nets.push({ name: netName, members });
		netName = '';
		members = undefined;
	};

	for (const line of lines) {
		if (line === '[') { // 器件块开始：打断未闭合的网络块（脏数据兜底）
			flush();
			inNet = false;
			continue;
		}
		if (line === '(') {
			flush();
			inNet = true;
			continue;
		}
		if (line === ')') {
			flush();
			inNet = false;
			continue;
		}
		if (!inNet || line === '')
			continue;
		if (netName === '') {
			// 网络块首行 = 网络名（去除引号）
			netName = line.replace(/^["']|["']$/g, '');
			members = [];
			continue;
		}
		// 成员行：位号-引脚号
		const m = line.match(/^(\S+)-([^\s-]+)$/);
		if (m && members) {
			const member = { designator: m[1], pinNumber: m[2] };
			members.push(member);
			pinNets.set(pinKey(member.designator, member.pinNumber), netName);
		}
	}
	flush();
	return { pinNets, nets };
}
