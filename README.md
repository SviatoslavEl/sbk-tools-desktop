# СБК Инструменты

Открытый portable-набор локальных desktop-инструментов:

- тендерный калькулятор;
- сканирование PDF/DOCX с пресетами, OCR и факсимиле;
- реестр опыта по договорам;
- кадровый реестр.

Инструменты независимы и не передают данные друг другу. Общими являются только интерфейс, portable workspace, резервное копирование и инфраструктура desktop-приложения.

## Текущее состояние

Первый инкремент содержит Tauri 2 / React 19 оболочку, светло-зелёную дизайн-систему и интерактивные прототипы четырёх модулей. Реальные движки ScanDocument и Bid Buddy будут переноситься поэтапно после фиксации regression baseline.

## Запуск

```bash
npm install
npm run tauri dev
```

Проверка frontend и Rust:

```bash
npm run check
```

## Portable workspace

Приложение создаёт `ProductData` рядом с исполняемым файлом. На macOS папка располагается рядом с `.app`, а не внутри подписанного bundle. Путь можно переопределить переменной `SBK_TOOLS_WORKSPACE`.

```text
ProductData/
  settings/
  calculator/
  scanner/
  contract-experience/
  staff/
  attachments/
  backups/
  logs/
```

## Документация

- [Архитектура](docs/ARCHITECTURE.md)
- [Продуктовое и UI/UX-задание](docs/PRODUCT_SPEC.md)
- [План миграции](docs/MIGRATION.md)

## Лицензия

GPL-3.0-only. См. [LICENSE](LICENSE).
