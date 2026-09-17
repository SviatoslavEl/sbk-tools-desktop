import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import "./collapsible-editor-block.css";

/** Collapse only the presentation: fields and their draft values stay mounted. */
export function CollapsibleEditorBlock({
  title,
  summary,
  defaultExpanded = false,
  revealKey = 0,
  children,
}: {
  title: string;
  summary?: string;
  defaultExpanded?: boolean;
  revealKey?: number;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded || revealKey > 0);
  const contentId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  // A new validation attempt reveals the invalid block without trapping it open.
  // Changes to title/defaultExpanded while typing must not reset the UI state.
  useEffect(() => {
    if (revealKey > 0) setExpanded(true);
  }, [revealKey]);
  const collapse = () => {
    setExpanded(false);
    toggleRef.current?.focus();
  };
  return (
    <section className="collapsible-editor-block">
      <button
        ref={toggleRef}
        type="button"
        className="collapsible-editor-toggle"
        aria-expanded={expanded}
        aria-controls={contentId}
        aria-label={`${expanded ? "Свернуть" : "Раскрыть"}: ${title}`}
        onClick={() => setExpanded((current) => !current)}
      >
        <svg className="collapsible-editor-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <span className="collapsible-editor-caption">
          <strong title={title}>{title}</strong>
          {summary && <small title={summary}>{summary}</small>}
        </span>
        <span className="collapsible-editor-action" aria-hidden="true">{expanded ? "Свернуть" : "Изменить"}</span>
      </button>
      <div id={contentId} className="collapsible-editor-content" hidden={!expanded} onInvalidCapture={() => setExpanded(true)}>
        {children}
        <div className="collapsible-editor-footer">
          <span>Сворачивание не сохраняет карточку в базу.</span>
          <button type="button" className="secondary small" onClick={collapse}>Свернуть блок</button>
        </div>
      </div>
    </section>
  );
}
