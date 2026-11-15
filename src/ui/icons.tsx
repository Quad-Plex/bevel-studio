import type { ReactNode } from 'react';

/**
 * Inline icon set. 20×20 view box, 1.6 px stroke, currentColor.
 * Icons are decorative by default; the control that contains one owns the name.
 */
export type IconProps = {
  size?: number;
  className?: string;
};

function Icon({ size = 16, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      shapeRendering="geometricPrecision"
    >
      {children}
    </svg>
  );
}

export function CursorIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.2 3.2v12.3l3.5-3.3 2.2 4.6 2.3-1.1-2.2-4.5 4.7-.3z" />
    </Icon>
  );
}

export function BrushIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14.7 3.5 16.5 5.3 9.1 12.7 6.3 13.5 7.1 10.7z" />
      <path d="M7.4 13.2c-.2 1.7-1.2 2.8-3.2 3.3.4-2 1.5-3.1 3.1-3.3z" />
    </Icon>
  );
}

export function BoxIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 2.8 16 6.3v7.4L10 17.2 4 13.7V6.3z" />
      <path d="M4 6.3 10 9.8l6-3.5" />
      <path d="M10 9.8v7.4" />
    </Icon>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 3.2v9.4" />
      <path d="M6.3 9 10 12.7 13.7 9" />
      <path d="M4.2 16.4h11.6" />
    </Icon>
  );
}

export function UndoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7.6 5.2 4 8.8l3.6 3.6" />
      <path d="M4 8.8h7.1a4.3 4.3 0 0 1 0 8.6H7.3" />
    </Icon>
  );
}

export function RedoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12.4 5.2 16 8.8l-3.6 3.6" />
      <path d="M16 8.8H8.9a4.3 4.3 0 0 0 0 8.6h3.8" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.5 5.5 14.5 14.5" />
      <path d="M14.5 5.5 5.5 14.5" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.5 8 10 12.5 14.5 8" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.6 10.4 8 13.8 15.4 5.7" />
    </Icon>
  );
}

export function WarningIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 3.4 17 15.8H3z" />
      <path d="M10 8.2v3.3" />
      <path d="M10 14v.1" />
    </Icon>
  );
}

export function EyeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.6 10c1.7-2.8 4.2-4.6 7.4-4.6s5.7 1.8 7.4 4.6c-1.7 2.8-4.2 4.6-7.4 4.6S4.3 12.8 2.6 10z" />
      <circle cx="10" cy="10" r="2.2" />
    </Icon>
  );
}

export function EyeOffIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.6 10c1.7-2.8 4.2-4.6 7.4-4.6s5.7 1.8 7.4 4.6c-1.7 2.8-4.2 4.6-7.4 4.6S4.3 12.8 2.6 10z" />
      <circle cx="10" cy="10" r="2.2" />
      <path d="M4.2 4 15.8 16" />
    </Icon>
  );
}

export function FitIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.4 7.2V3.4h3.8" />
      <path d="M12.8 3.4h3.8v3.8" />
      <path d="M16.6 12.8v3.8h-3.8" />
      <path d="M7.2 16.6H3.4v-3.8" />
    </Icon>
  );
}

export function RotateIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M15.9 6a6.2 6.2 0 1 0 .3 4" />
      <path d="M16.3 3.1v3.2H13.1" />
    </Icon>
  );
}

export function LayersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 2.8 16.3 6.1 10 9.4 3.7 6.1z" />
      <path d="M3.7 10 10 13.3 16.3 10" />
      <path d="M3.7 13.6 10 16.9 16.3 13.6" />
    </Icon>
  );
}

export function FileIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.9 2.8h5.4l4.2 4.2v10.2H5.9z" />
      <path d="M11.3 2.8v4.4h4.2" />
    </Icon>
  );
}
