import type { NextApiRequest, NextApiResponse } from 'next';
import { Company, getCompanies, getAvailableDates, getLatestDate } from '../../lib/data';

export default function handler(
  req: NextApiRequest,
  res: NextApiResponse<Company[] | { error: string; dates?: string[] }>
) {
  const { date } = req.query;

  // 未指定日期 → 返回最新数据
  if (!date || typeof date !== 'string') {
    const latest = getLatestDate();
    if (!latest) return res.status(404).json({ error: 'no data' });
    return res.status(200).json(getCompanies(latest));
  }

  // 列出可用日期
  if (date === '_dates') {
    return res.status(200).json(getAvailableDates() as any);
  }

  // 指定日期 → 返回该日期数据
  const companies = getCompanies(date);
  res.status(200).json(companies);
}
