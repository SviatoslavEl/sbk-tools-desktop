import { Component, type ErrorInfo, type ReactNode } from "react";

export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Application interface failed", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="startup-screen" role="alert">
        <section className="startup-card">
          <div className="brand-mark large">СБК</div>
          <h1>Не удалось отобразить раздел</h1>
          <p>Данные не удалены. Перезапустите интерфейс и проверьте последнее изменённое поле.</p>
          <details>
            <summary>Техническая информация</summary>
            <pre className="import-report">{this.state.error.message}</pre>
          </details>
          <button className="primary" type="button" onClick={() => window.location.reload()}>
            Перезапустить интерфейс
          </button>
        </section>
      </main>
    );
  }
}
