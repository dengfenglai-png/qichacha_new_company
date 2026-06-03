import { GetStaticProps } from 'next';
import { Company, getAvailableDates, getCompanies, getLatestDate } from '../lib/data';
import CompanyTable from '../components/CompanyTable';
import { useState } from 'react';

export default function Home({ initialCompanies, initialDate, allDates }: {
  initialCompanies: Company[];
  initialDate: string | null;
  allDates: string[];
}) {
  const [date, setDate] = useState(initialDate || '');
  const [companies, setCompanies] = useState(initialCompanies);

  async function handleDateChange(newDate: string) {
    setDate(newDate);
    if (newDate === initialDate) {
      setCompanies(initialCompanies);
    } else {
      const res = await fetch(`/api/companies?date=${newDate}`);
      const data = await res.json();
      setCompanies(data);
    }
  }

  return (
    <main>
      <h1>北京市东城区 — 每日新增企业</h1>

      <div className="controls">
        <label>
          选择日期：
          <select value={date} onChange={e => handleDateChange(e.target.value)}>
            {allDates.map(d => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </label>
        <span className="count">共 {companies.length} 条</span>
      </div>

      <CompanyTable companies={companies} />

      <footer>
        <p>数据来源：企查查 · 每日自动更新 · 仅含工作日数据</p>
      </footer>

      <style jsx>{`
        main { max-width: 1400px; margin: 0 auto; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
        h1 { font-size: 1.5rem; margin-bottom: 16px; }
        .controls { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
        select { padding: 6px 12px; font-size: 14px; border-radius: 6px; border: 1px solid #ccc; }
        .count { color: #666; font-size: 14px; }
        footer { margin-top: 32px; color: #999; font-size: 12px; text-align: center; }
      `}</style>

      <style jsx global>{`
        body { margin: 0; background: #f5f5f5; }
        .table-wrapper { overflow-x: auto; background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        table { width: 100%; border-collapse: collapse; font-size: 14px; }
        th { background: #fafafa; padding: 10px 12px; text-align: left; font-weight: 600; border-bottom: 2px solid #e8e8e8; white-space: nowrap; }
        td { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; }
        tr:hover td { background: #fafafa; }
        .num { text-align: center; width: 40px; }
        .name { font-weight: 500; min-width: 200px; }
        .code { font-family: monospace; font-size: 12px; min-width: 160px; }
        .addr { font-size: 12px; color: #666; min-width: 200px; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .empty { text-align: center; color: #999; padding: 40px; }
        @media (max-width: 768px) {
          table { font-size: 12px; }
          th, td { padding: 6px 8px; }
          .addr { max-width: 150px; }
        }
      `}</style>
    </main>
  );
}

export const getStaticProps: GetStaticProps = async () => {
  const allDates = getAvailableDates();
  const latestDate = getLatestDate();
  const initialCompanies = latestDate ? getCompanies(latestDate) : [];
  return {
    props: { initialCompanies, initialDate: latestDate, allDates },
  };
};
