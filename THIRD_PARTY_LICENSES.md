# Сторонние компоненты

Краткий указатель лицензий. Полные тексты и copyright notices соответствующих компонентов сохраняются в их исходных дистрибутивах и должны сопровождать бинарную поставку.

| Компонент | Назначение | Лицензия |
|---|---|---|
| Tauri и плагины Tauri | desktop-оболочка | Apache-2.0 / MIT |
| React, React DOM, Vite | пользовательский интерфейс | MIT |
| Rust и crates.io зависимости | локальный host, SQLite, архивы, XLSX | лицензии отдельных пакетов; преимущественно Apache-2.0 / MIT |
| Python | runtime worker | Python Software Foundation License |
| NumPy | обработка изображений | BSD-3-Clause |
| Pillow | обработка изображений | HPND |
| pypdf | операции с PDF | BSD-3-Clause |
| pypdfium2 / PDFium | рендеринг PDF | Apache-2.0 / BSD-3-Clause и notices Chromium/PDFium |
| python-docx | чтение DOCX | MIT |
| ReportLab | генерация PDF | BSD-3-Clause |
| Tesseract OCR | распознавание текста | Apache-2.0 |
| tessdata / tessdata_fast | языковые модели OCR | Apache-2.0 |
| LibreOffice | локальная конвертация DOCX | MPL-2.0 / LGPL-3.0-or-later |
| SQLite | локальные базы | Public Domain |

LibreOffice и Tesseract запускаются как самостоятельные локальные программы. Ссылки и контрольные суммы загрузок закреплены в `scripts/stage_libreoffice.py` и release workflow.
