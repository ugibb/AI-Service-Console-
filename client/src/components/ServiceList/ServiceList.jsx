import { ServiceCard } from '../ServiceCard/ServiceCard.jsx';
import './ServiceList.css';

/**
 * 服务列表（T1.14）。
 *
 * 控制台重启后，上个会话启动且验明正身（pid + OS 创建时间）仍在跑的服务显示为
 * 「已接管」——不是孤儿也不是「已停止」，停止/重启照常可用。原来的
 * 「状态可能不准确，请手动对齐」免责声明随真接管的落地一并移除。
 */
export function ServiceList({
  services = [],
  warnings = [],
  pending = {},
  loaded = false,
  activeId = null,
  onStart,
  onStop,
  onRestart,
  onEdit,
  onDelete,
  onOpenLogs,
  onCreate,
}) {
  const hasServices = services.length > 0;
  // 就地算，别从 services 上取字段：services 是数组，`services.runningCount` 恒为
  // undefined，JSX 里渲染成空白——统计条会变成「运行中 个」。
  // running 与 adopted 都算在跑（adopted 只是「上个会话起的」）；starting / stopping
  // 是过渡态，还没到稳态，计进去会让人以为已经跑起来了。
  const runningCount = services.filter((service) => service.status === 'running' || service.status === 'adopted').length;

  return (
    <section className="service-list" aria-label="服务列表">
      {/* 统计、卡片、新增按钮挤在同一行：这整块的高度是从日志区借的，
          分两行（原来统计一行、卡片一行）等于白送一行高度给空白。
          h2 与「新增服务」永远在场，卡片横向排在中间、超出就左右滑动。 */}
      <div className="service-list__bar">
        <h2 className="service-list__title">
          纳管服务
          <span className="service-list__count-text">共</span>
          <span className="service-list__count">{services.length}</span>
          <span className="service-list__count-text">个服务，运行中</span>
          <span className="service-list__count">{runningCount}</span>
          <span className="service-list__count-text">个</span>
        </h2>

        {hasServices ? (
          <div className="service-list__items">
            {services.map((service) => (
              <ServiceCard
                key={service.id}
                service={service}
                busy={pending[service.id] ?? null}
                active={service.id === activeId}
                onStart={onStart}
                onStop={onStop}
                onRestart={onRestart}
                onEdit={onEdit}
                onDelete={onDelete}
                onOpenLogs={onOpenLogs}
              />
            ))}
          </div>
        ) : null}

        <button type="button" className="btn btn--primary" onClick={onCreate}>
          新增服务
        </button>
      </div>

      {warnings.length > 0 ? (
        <ul className="service-list__warnings" role="status">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      {!loaded ? (
        <p className="service-list__loading">正在读取服务配置…</p>
      ) : hasServices ? null : (
        <div className="service-list__empty">
          <p className="service-list__empty-title">还没有登记任何服务</p>
          <p className="service-list__empty-hint">
            登记服务只需两样东西：启动脚本（.bat）的路径，和它自己写的日志文件路径。 登记后就不用再找目录、记命令了。
          </p>
          <button type="button" className="btn btn--primary" onClick={onCreate}>
            登记第一个服务
          </button>
        </div>
      )}
    </section>
  );
}
