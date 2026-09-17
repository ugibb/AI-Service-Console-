import { ServiceCard } from '../ServiceCard/ServiceCard.jsx';
import './ServiceList.css';

/**
 * 服务列表（T1.14）。
 *
 * 「状态可能不准确」是 PRD §9 明确要求的边界提示：控制台重启后拿不到旧进程句柄，
 * 会把仍在跑的服务显示成「已停止」。不提示等于骗用户。
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

  return (
    <section className="service-list" aria-label="服务列表">
      <div className="service-list__bar">
        <h2 className="service-list__title">
          纳管服务
          <span className="service-list__count">{services.length}</span>
        </h2>
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
      ) : hasServices ? (
        <>
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
          <p className="service-list__disclaimer">
            状态可能不准确：控制台重启后无法接管此前已启动的进程，可能显示为「已停止」； 若与实际不符，请到任务管理器或用 taskkill
            手动对齐。
          </p>
        </>
      ) : (
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
