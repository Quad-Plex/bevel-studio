import type { ReactNode } from 'react';
import { Tooltip } from './Tooltip';

export type IconButtonProps = {
  label: string;
  icon: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
};

export function IconButton({
  label,
  icon,
  variant = 'ghost',
  active,
  disabled = false,
  onClick,
}: IconButtonProps) {
  const isToggle = active !== undefined;
  return (
    <Tooltip content={label}>
      <button
        type="button"
        className={`bs-iconbtn bs-iconbtn--${variant}${active ? ' is-active' : ''}`}
        aria-label={label}
        aria-pressed={isToggle ? active : undefined}
        disabled={disabled}
        onClick={onClick}
      >
        <span className="bs-iconbtn__glyph" aria-hidden="true">
          {icon}
        </span>
      </button>
    </Tooltip>
  );
}
