export const workspacePasswordHint =
  "От 6 до 128 символов: русские и латинские буквы, цифры, пробелы и специальные символы. Пробелы в начале и конце недопустимы.";

export function workspacePasswordError(password: string): string {
  const length = [...password].length;
  if (length < 6) return "Пароль должен содержать не менее 6 символов.";
  if (length > 128) return "Пароль должен содержать не более 128 символов.";
  if (password.trim() !== password)
    return "Уберите пробелы в начале и конце пароля.";
  if ([...password].some((character) => /[\u0000-\u001f\u007f]/u.test(character)))
    return "Управляющие символы в пароле недопустимы.";
  return "";
}
