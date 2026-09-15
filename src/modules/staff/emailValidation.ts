export const staffEmailHint = "Необязательно. Один адрес, например name@example.com, без пробелов внутри.";
export const staffEmailFormatError = "Укажите корректный email, например name@example.com, или оставьте поле пустым. Допускается один адрес без пробелов внутри.";

// HTML-like syntax only: no DNS requests, mailbox checks or data rewriting.
const emailPattern = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export function validateStaffEmail(email: string, previousEmail?: string): { error: string; warning: string } {
  const value = email.trim();
  if (!value || emailPattern.test(value)) return { error: "", warning: "" };
  if (previousEmail !== undefined && email === previousEmail) {
    return { error: "", warning: "Ранее сохранённый email имеет неверный формат. Другие поля можно сохранить, оставив адрес без изменений. При изменении укажите корректный адрес либо оставьте поле пустым." };
  }
  return { error: staffEmailFormatError, warning: "" };
}
