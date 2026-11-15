import { useId } from 'react';

export type ToggleProps = {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  description?: string;
};

export function Toggle({ label, checked, onChange, description }: ToggleProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;

  return (
    <div className="bs-toggle">
      <span className="bs-toggle__text">
        <label className="bs-toggle__label" htmlFor={id} id={labelId}>
          {label}
        </label>
        {description && (
          <span className="bs-toggle__description" id={descriptionId}>
            {description}
          </span>
        )}
      </span>

      <button
        id={id}
        type="button"
        role="switch"
        className="bs-switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={description ? descriptionId : undefined}
        onClick={() => onChange(!checked)}
      >
        <span className="bs-switch__thumb" aria-hidden="true" />
      </button>
    </div>
  );
}
