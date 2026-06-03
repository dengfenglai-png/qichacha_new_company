import fs from 'fs';
import path from 'path';

export interface Company {
  name: string;
  status: string;
  representative: string;
  capital: string;
  date: string;
  creditCode: string;
  address: string;
}

export function getAvailableDates(): string[] {
  const dataDir = path.join(process.cwd(), 'data');
  try {
    const files = fs.readdirSync(dataDir);
    return files
      .filter(f => f.startsWith('new_companies_') && f.endsWith('.json'))
      .map(f => f.replace('new_companies_', '').replace('.json', ''))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export function getCompanies(date: string): Company[] {
  const filePath = path.join(process.cwd(), 'data', `new_companies_${date}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
}

export function getLatestDate(): string | null {
  const dates = getAvailableDates();
  return dates.length > 0 ? dates[0] : null;
}
