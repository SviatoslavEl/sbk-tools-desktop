import { useEffect, useId, useRef, useState } from "react";
import "./staff-optional-date-field.css";

/** Empty native dates can look like today's date in WebKit; mount one only on intent. */
export function StaffOptionalDateField({
  label,
  value,
  onChange,
  disabled = false,
  readOnly = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  readOnly?: boolean;
}) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const intentRef = useRef<HTMLButtonElement>(null);
  const focusInput = useRef(false);
  const focusIntent = useRef(false);
  const canEdit = !disabled && !readOnly;
  const showInput = Boolean(value) || (editing && canEdit);

  useEffect(() => {
    if (!canEdit) {
      focusInput.current = false;
      focusIntent.current = false;
      setEditing(false);
      return;
    }
    if (editing && focusInput.current) {
      focusInput.current = false;
      inputRef.current?.focus({ preventScroll: true });
    } else if (!editing && !value && focusIntent.current) {
      focusIntent.current = false;
      intentRef.current?.focus({ preventScroll: true });
    }
  }, [canEdit, editing, value]);

  const leaveEmpty = () => {
    if (!canEdit) return;
    focusInput.current = false;
    focusIntent.current = true;
    setEditing(false);
  };

  return (
    <div className="staff-optional-date-field">
      <label id={`${id}-label`} htmlFor={showInput ? id : undefined}>{label}</label>
      {showInput ? (
        <>
          <input
            ref={inputRef}
            id={id}
            type="date"
            aria-label={label}
            aria-describedby={!value ? `${id}-empty` : undefined}
            value={value}
            disabled={disabled}
            readOnly={readOnly}
            onChange={(event) => {
              if (!canEdit) return;
              // Partial native date entry reports "" too: keep this same input mounted.
              setEditing(true);
              onChange(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || value || !canEdit) return;
              event.preventDefault();
              event.stopPropagation();
              leaveEmpty();
            }}
          />
          {!value && <small id={`${id}-empty`}>Не указана</small>}
          {canEdit && (
            <button
              type="button"
              className="staff-optional-date-action"
              aria-label={`${value ? "Очистить дату" : "Оставить без даты"}: ${label}`}
              onClick={() => {
                if (!canEdit) return;
                if (value) onChange("");
                leaveEmpty();
              }}
            >{value ? "Очистить дату" : "Оставить без даты"}</button>
          )}
        </>
      ) : (
        <div className="staff-optional-date-empty" aria-labelledby={`${id}-label`}>
          <span>Не указана</span>
          <button
            ref={intentRef}
            type="button"
            className="staff-optional-date-action"
            aria-label={`Указать дату: ${label}`}
            disabled={!canEdit}
            onClick={() => {
              if (!canEdit) return;
              focusInput.current = true;
              focusIntent.current = false;
              setEditing(true);
            }}
          >Указать дату</button>
        </div>
      )}
    </div>
  );
}
