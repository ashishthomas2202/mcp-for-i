import Crypto from "crypto";
import { diffArrays } from "diff";

export class SourceDateStore {
  private baseDates = new Map<string, string[]>();
  private baseSource = new Map<string, string>();
  private recordLengths = new Map<string, number>();

  setBase(key: string, source: string, dates: string[], recordLength: number) {
    this.baseSource.set(key, source);
    this.baseDates.set(key, dates);
    this.recordLengths.set(key, recordLength);
  }

  getRecordLength(key: string) {
    return this.recordLengths.get(key);
  }

  getBaseSource(key: string) {
    return this.baseSource.get(key);
  }

  getBaseDates(key: string) {
    return this.baseDates.get(key);
  }

  calcNewSourceDates(key: string, newSource: string) {
    const oldSource = this.baseSource.get(key) || "";
    const oldDates = this.baseDates.get(key) || [];

    const oldLines = oldSource.split("\n");
    const newLines = newSource.split("\n");

    // Use diff to map unchanged lines to old dates
    const diff = diffArrays(oldLines, newLines);
    const newDates: string[] = [];
    const today = currentStamp();

    let oldIndex = 0;
    for (const part of diff) {
      if (part.added) {
        for (let i = 0; i < part.value.length; i++) {
          newDates.push(today);
        }
      } else if (part.removed) {
        oldIndex += part.value.length;
      } else {
        for (let i = 0; i < part.value.length; i++) {
          const date = oldDates[oldIndex + i] || today;
          newDates.push(date);
        }
        oldIndex += part.value.length;
      }
    }

    return newDates;
  }
}

export function makeAliasName(key: string) {
  return `MCP_${Crypto.createHash("sha1").update(key).digest("hex")}`.toUpperCase();
}

export function currentStamp(): string {
  const today = new Date();
  const mm = today.getMonth() + 1;
  const dd = today.getDate();
  const yy = String(today.getFullYear()).substring(2);
  return [yy, (mm > 9 ? `` : `0`) + mm, (dd > 9 ? `` : `0`) + dd].join(``);
}
