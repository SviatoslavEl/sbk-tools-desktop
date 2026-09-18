import { useEffect, useState } from "react";
import { activityEvent, getActivities } from "../../lib/activity";
export function StatusIndicator() {
  const count = () => getActivities().filter((entry) => entry.status === "error").length;
  const [errors, setErrors] = useState(count);
  useEffect(() => { const update = () => setErrors(count()); window.addEventListener(activityEvent, update); return () => window.removeEventListener(activityEvent, update); }, []);
  return errors > 0 ? <span className="status-error-count" aria-label={`Ошибок операций: ${errors}`} title="В центре состояния есть ошибки операций">{errors}</span> : null;
}
