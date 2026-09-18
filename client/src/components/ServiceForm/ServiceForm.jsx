import { useId, useState } from 'react';
import './ServiceForm.css';

/** 与 server/src/lib/validate.js 的 CMD_UNSAFE_PATTERN 保持一致（前端只做提前提示，权威校验在服务端） */
const CMD_UNSAFE_PATTERN = /["&|<>^\r\n\0]/;

/** 与 server/src/lib/validate.js 的 MAX_STARTUP_GRACE_MS 保持一致（30 分钟） */
const MAX_STARTUP_GRACE_MS = 30 * 60 * 1000;

const FIELDS = Object.freeze([
  { key: 'name', label: '名称', hint: '显示用，例如「订单服务」', placeholder: '订单服务' },
  { key: 'workDir', label: '工作目录', hint: '启动脚本将在此目录下执行', placeholder: 'C:\\services\\order' },
  { key: 'startScript', label: '启动脚本', hint: '要执行的 .bat 文件；建议填绝对路径', placeholder: 'C:\\services\\order\\start.bat' },
  {
    key: 'logFile',
    label: '日志文件',
    hint: '服务自己写的日志文件；控制台只读它。文件名按天变的服务，用 {date} 代替日期，例如 D:\\svc\\logs\\{date}.log（每次读取时展开成当天，不用天天改配置）',
    placeholder: 'C:\\services\\order\\logs\\app.log',
  },
  {
    key: 'port',
    label: '端口',
    hint: '选填。填写后每次启动前会自动结束占用该端口的进程，确保系统里只有一个实例在跑',
    placeholder: '8081',
    numeric: true,
  },
  {
    key: 'startupGraceMs',
    label: '启动宽限期',
    hint: '选填，单位毫秒；留空沿用全局默认。宽限期内进程还活着显示「启动中」并计时，超过才判定「运行中」。AI 服务加载模型慢，建议 60000（60 秒）或更大',
    placeholder: '60000',
    numeric: true,
  },
]);

const emptyValues = { name: '', workDir: '', startScript: '', logFile: '', port: '', startupGraceMs: '' };

const toFormValues = (initialValue) => ({
  name: initialValue?.name ?? '',
  workDir: initialValue?.workDir ?? '',
  startScript: initialValue?.startScript ?? '',
  logFile: initialValue?.logFile ?? '',
  port: initialValue?.port == null ? '' : String(initialValue.port),
  startupGraceMs: initialValue?.startupGraceMs == null ? '' : String(initialValue.startupGraceMs),
});

function parsePort(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { ok: true, value: null };
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < 1 || value > 65535) return { ok: false };
  return { ok: true, value };
}

/** 留空 = 沿用服务端全局默认（null）；0 是合法值，表示显式关闭宽限期 */
function parseGrace(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { ok: true, value: null };
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < 0 || value > MAX_STARTUP_GRACE_MS) return { ok: false };
  return { ok: true, value };
}

export function validate(values) {
  const errors = {};
  for (const key of ['name', 'workDir', 'startScript', 'logFile']) {
    if (String(values[key] ?? '').trim() === '') {
      const label = FIELDS.find((field) => field.key === key).label;
      errors[key] = `${label}不能为空`;
    }
  }
  for (const key of ['workDir', 'startScript', 'logFile']) {
    const raw = String(values[key] ?? '');
    if (!errors[key] && CMD_UNSAFE_PATTERN.test(raw)) {
      errors[key] = '路径含有 cmd 特殊字符（" & | < > ^），无法通过 cmd.exe 执行';
    }
  }
  if (!parsePort(values.port).ok) {
    errors.port = '端口需为 1-65535 之间的整数，或留空';
  }
  if (!parseGrace(values.startupGraceMs).ok) {
    errors.startupGraceMs = `启动宽限期需为 0-${MAX_STARTUP_GRACE_MS} 之间的整数毫秒数，或留空（注意单位是毫秒，60000 = 60 秒）`;
  }
  return errors;
}

/**
 * 新增 / 编辑表单（T1.15）。
 * 只用两个必填概念：要让服务跑起来，最少的输入是什么——脚本路径 + 日志路径 + 工作目录 + 名称。
 */
export function ServiceForm({ initialValue = null, onSubmit, onCancel, submitting = false, error = null }) {
  const formId = useId();
  const [values, setValues] = useState(() => (initialValue ? toFormValues(initialValue) : { ...emptyValues }));
  const [errors, setErrors] = useState({});
  const isEdit = Boolean(initialValue);

  const update = (key) => (event) => {
    const { value } = event.target;
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    if (submitting) return;
    const found = validate(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const port = parsePort(values.port);
    onSubmit({
      name: values.name.trim(),
      workDir: values.workDir.trim(),
      startScript: values.startScript.trim(),
      logFile: values.logFile.trim(),
      port: port.value,
      startupGraceMs: parseGrace(values.startupGraceMs).value,
    });
  };

  return (
    <form className="service-form" onSubmit={handleSubmit} noValidate>
      <h2 className="service-form__title">{isEdit ? '编辑服务' : '新增服务'}</h2>

      {error ? (
        <p className="service-form__error" role="alert">
          {error.message}
        </p>
      ) : null}

      <div className="service-form__fields">
        {FIELDS.map((field) => (
          <p className="field" key={field.key}>
            <label className="field__label" htmlFor={`${formId}-${field.key}`}>
              {field.label}
            </label>
            <input
              id={`${formId}-${field.key}`}
              className="field__input"
              type="text"
              inputMode={field.numeric ? 'numeric' : undefined}
              value={values[field.key]}
              placeholder={field.placeholder}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={errors[field.key] ? 'true' : undefined}
              onChange={update(field.key)}
            />
            {errors[field.key] ? (
              <span className="field__error">{errors[field.key]}</span>
            ) : (
              <span className="field__hint">{field.hint}</span>
            )}
          </p>
        ))}
      </div>

      <div className="service-form__actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="btn btn--primary" disabled={submitting}>
          {submitting ? '保存中…' : '保存'}
        </button>
      </div>
    </form>
  );
}
