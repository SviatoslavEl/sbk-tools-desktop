# СБК Инструменты 1.0

Открытое portable desktop-приложение для Windows и macOS с четырьмя независимыми инструментами:

- тендерный калькулятор с дополнительными расходами, конкурентами, рекомендацией цены и графиками;
- обработка PDF/DOCX с пресетами, OCR и размещением факсимиле;
- реестр опыта по договорам со статусами стадии, оплаты и актов;
- кадровый реестр с основанием сотрудничества и документами сотрудников.

Инструменты не передают данные друг другу. Общими являются только оболочка, светло-зелёная дизайн-система, portable-хранилище и резервные копии. Все операции выполняются на компьютере пользователя без серверной обработки.

## Готовые сборки

Сборки публикуются в разделе **Releases**:

- Windows x64 — самораспаковывающийся portable EXE и стандартные пакеты Tauri;
- macOS — `.app`/DMG отдельно для Apple Silicon и Intel.

При первом запуске portable EXE создаёт рядом папку `SBK-Tools-Portable`; пользовательские данные находятся в `ProductData` и не удаляются при обновлении программы.

## Разработка

Требуются Node.js 22+, Rust stable и Python 3.11/3.12.

```bash
npm ci
npm run check
npm run tauri dev
```

Worker сканера собирается отдельно:

```bash
python -m venv .venv-scanner
.venv-scanner/bin/pip install -e scanner-worker nuitka ordered-set zstandard
.venv-scanner/bin/python scripts/build_scanner_worker.py
```

LibreOffice и Tesseract входят в релизные пакеты. Скрипт `scripts/stage_libreoffice.py` загружает строго закреплённую версию LibreOffice и проверяет SHA-256.

## Portable workspace

По умолчанию приложение создаёт `ProductData` рядом с `.app` или исполняемым файлом. Если это место защищено от записи, используется доступная системная папка; расположение можно изменить в настройках.

```text
ProductData/
  settings/              отдельная SQLite-база
  calculator/            отдельная SQLite-база
  scanner/               отдельная SQLite-база
  contract-experience/   отдельная SQLite-база
  staff/                 отдельная SQLite-база
  attachments/
  backups/
  exports/
```

Перед миграциями базы создаётся страховочная копия. Полная резервная копия имеет расширение `.sbkbackup`.

## Документация

- [Архитектура](docs/ARCHITECTURE.md)
- [UI/UX и продуктовая спецификация](docs/PRODUCT_SPEC.md)
- [Безопасная миграция](docs/MIGRATION.md)
- [Лицензии компонентов](THIRD_PARTY_LICENSES.md)

## Лицензия

Исходный код распространяется по GPL-3.0-only. Сторонние компоненты сохраняют собственные лицензии.
