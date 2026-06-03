import { Company } from '../lib/data';

export default function CompanyTable({ companies }: { companies: Company[] }) {
  if (companies.length === 0) {
    return <p className="empty">暂无数据（可能是周末或节假日）</p>;
  }

  return (
    <div className="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>企业名称</th>
            <th>状态</th>
            <th>法定代表人</th>
            <th>注册资本</th>
            <th>统一社会信用代码</th>
            <th>地址</th>
          </tr>
        </thead>
        <tbody>
          {companies.map((c, i) => (
            <tr key={c.creditCode || i}>
              <td className="num">{i + 1}</td>
              <td className="name">{c.name}</td>
              <td>{c.status}</td>
              <td>{c.representative}</td>
              <td className="num">{c.capital}</td>
              <td className="code">{c.creditCode}</td>
              <td className="addr">{c.address}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
