import { describe, expect, it } from "vitest";
import { actsStatusTone, contractStageTone, paymentStatusTone, staffBasisTone } from "./statusTone";

describe("цветовые схемы статусов", () => {
  it("различает исполнение, оплату и акты по смыслу", () => {
    expect(contractStageTone("Выполнен")).toBe("success");
    expect(contractStageTone("Расторгнут")).toBe("danger");
    expect(paymentStatusTone("Полностью оплачено")).toBe("success");
    expect(paymentStatusTone("Просрочено")).toBe("danger");
    expect(actsStatusTone("Направлены")).toBe("info");
    expect(actsStatusTone("Есть замечания")).toBe("danger");
  });

  it("показывает разный тип основания кадров", () => {
    expect(staffBasisTone("Штат")).toBe("success");
    expect(staffBasisTone("ГПХ")).toBe("warning");
    expect(staffBasisTone("Самозанятый")).toBe("violet");
  });
});
