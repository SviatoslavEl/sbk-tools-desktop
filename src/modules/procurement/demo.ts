import { emptyChecklist, emptyProcurement, emptyRequirement, type ProcurementData } from "./types";

export interface DemoProcurement {
  id: string;
  item: ProcurementData;
}

const isoOffset = (base: Date, days: number) => {
  const value = new Date(base);
  value.setHours(12, 0, 0, 0);
  value.setDate(value.getDate() + days);
  return value.toISOString().slice(0, 10);
};

export function demoProcurements(base = new Date()): DemoProcurement[] {
  const make = (
    id: string,
    patch: Partial<ProcurementData>,
    requirements: Array<[string, string, ProcurementData["requirements"][number]["status"] ]>,
    checklist: Array<[string, boolean]>,
  ): DemoProcurement => ({
    id,
    item: {
      ...emptyProcurement(),
      ...patch,
      requirements: requirements.map(([text, evidence, status], index) => ({
        ...emptyRequirement(), id: `${id}-requirement-${index + 1}`, text, evidence, status,
      })),
      checklist: checklist.map(([text, done], index) => ({
        ...emptyChecklist(), id: `${id}-check-${index + 1}`, text, done,
        dueDate: isoOffset(base, 4 + index), responsible: index % 2 ? "Технический специалист" : "Тендерный менеджер",
      })),
      notes: "Демонстрационная карточка. Её можно свободно изменять или переместить в архив.",
    },
  });

  return [
    make("d3a10001-5b4c-4d02-8a11-000000000001", {
      name: "ДЕМО · Аудит информационной безопасности",
      customer: "АО «Региональная энергетическая компания»",
      subject: "Аудит информационной безопасности и проверка соответствия требованиям ГОСТ",
      nmc: 8_450_000,
      platform: "ЕИС / электронная площадка",
      publishedDate: isoOffset(base, -2),
      questionDeadline: isoOffset(base, 4),
      submissionDeadline: isoOffset(base, 9),
      executionStartDate: isoOffset(base, 25),
      executionEndDate: isoOffset(base, 115),
      responsible: "Тендерный менеджер",
      status: "Подготовка",
    }, [
      ["Опыт не менее двух аналогичных проектов", "Подобрать договоры из реестра опыта", "Частично подтверждено"],
      ["В команде должен быть сертифицированный аудитор", "Подобрать сотрудника и проверить сертификат", "Требует уточнения"],
      ["Срок выполнения не более 90 календарных дней", "Проверен календарный план", "Подтверждено"],
    ], [["Подобрать релевантный опыт", false], ["Подобрать команду", false], ["Проверить проект договора", true]]),
    make("d3a10002-5b4c-4d02-8a11-000000000002", {
      name: "ДЕМО · Оснащение испытательной лаборатории",
      customer: "ФГБУ «Центр стандартизации»",
      subject: "Поставка, монтаж и ввод в эксплуатацию лабораторного оборудования",
      nmc: 24_780_000,
      platform: "РТС-тендер",
      publishedDate: isoOffset(base, -8),
      questionDeadline: isoOffset(base, 1),
      submissionDeadline: isoOffset(base, 6),
      executionStartDate: isoOffset(base, 30),
      executionEndDate: isoOffset(base, 150),
      responsible: "Руководитель направления",
      status: "Подготовка",
    }, [
      ["Авторизация производителя на поставляемое оборудование", "Ожидается письмо производителя", "Требует уточнения"],
      ["Опыт поставки оборудования сопоставимой стоимости", "Требуется подбор договоров", "Частично подтверждено"],
      ["Гарантия не менее 24 месяцев", "Условие подтверждено поставщиком", "Подтверждено"],
    ], [["Запросить авторизационное письмо", false], ["Сверить технические характеристики", true], ["Подготовить ценовое предложение", false]]),
    make("d3a10003-5b4c-4d02-8a11-000000000003", {
      name: "ДЕМО · Корпоративное обучение специалистов",
      customer: "ООО «Промышленная группа»",
      subject: "Разработка и проведение программы повышения квалификации специалистов",
      nmc: 3_200_000,
      platform: "B2B-Center",
      publishedDate: isoOffset(base, -15),
      questionDeadline: isoOffset(base, -7),
      submissionDeadline: isoOffset(base, -1),
      executionStartDate: isoOffset(base, 10),
      executionEndDate: isoOffset(base, 75),
      responsible: "Менеджер проектов",
      status: "Подана",
    }, [
      ["Преподаватели со стажем не менее пяти лет", "Состав команды приложен", "Подтверждено"],
      ["Наличие образовательной лицензии", "Копия лицензии приложена", "Подтверждено"],
      ["Не менее трёх завершённых аналогичных договоров", "Справка об опыте подготовлена", "Подтверждено"],
    ], [["Проверить комплект заявки", true], ["Загрузить заявку на площадку", true], ["Зафиксировать протокол подачи", true]]),
  ];
}
