import { useId } from "react";
import { ANNOTATION_COLOR_CHOICES, annotationColor, colorCheckmark, type ColoredAnnotationKind } from "./annotationColors";

interface AnnotationColorPickerProps {
  kind: ColoredAnnotationKind;
  value: string;
  label: string;
  disabled?: boolean;
  onChange: (color: string) => void;
}

export function AnnotationColorPicker({ kind, value, label, disabled = false, onChange }: AnnotationColorPickerProps) {
  const labelId = useId();
  const color = annotationColor(kind, value);
  return <div className="annotation-color-picker" role="group" aria-labelledby={labelId}>
    <span id={labelId} className="annotation-color-label">{label}</span>
    <div className="annotation-color-choices">
      {ANNOTATION_COLOR_CHOICES.map((choice) => <button
        className="annotation-color-swatch"
        key={choice.value}
        type="button"
        aria-label={`${label}: ${choice.label}`}
        title={choice.label}
        aria-pressed={color === choice.value}
        disabled={disabled}
        style={{ backgroundColor: choice.value, color: colorCheckmark(choice.value) }}
        onClick={() => onChange(choice.value)}
      >{color === choice.value ? "✓" : ""}</button>)}
      <label className="annotation-custom-color" title="Выбрать любой цвет">
        <input type="color" value={color} aria-label={`${label}: свой цвет`} disabled={disabled} onChange={(event) => onChange(annotationColor(kind, event.target.value))} />
        <span>Свой</span>
      </label>
    </div>
  </div>;
}
