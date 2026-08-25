import { highRiskDomainsOf } from "@/lib/gateway/domains";
import { evaluateSod } from "@/lib/employees/sod";
import type { Employee, RiskDomain } from "@/lib/types";

export interface ConcentrationReport {
  orgHighRiskDomainCount: number;
  employees: Array<{
    employeeId: string;
    displayName: string;
    highRiskDomains: RiskDomain[];
    scopeCount: number;
    share: number;
    sodLevel: ReturnType<typeof evaluateSod>["level"];
  }>;
  maxShare: number;
  flagged: string[];
}

export function buildConcentration(employees: Employee[]): ConcentrationReport {
  const rows = employees.map((employee) => ({
    employee,
    domains: highRiskDomainsOf(employee.scopes),
  }));
  const orgDomains = new Set(rows.flatMap((row) => row.domains));
  const total = orgDomains.size;
  const reportRows = rows.map(({ employee, domains }) => {
    const share = total > 0 ? domains.length / total : 0;
    return {
      employeeId: employee.id,
      displayName: employee.displayName,
      highRiskDomains: domains,
      scopeCount: employee.scopes.length,
      share,
      sodLevel: evaluateSod(employee.scopes).level,
    };
  });
  return {
    orgHighRiskDomainCount: total,
    employees: reportRows,
    maxShare: Math.max(0, ...reportRows.map((row) => row.share)),
    flagged: reportRows
      .filter((row) => row.share >= 0.5 && row.highRiskDomains.length >= 2)
      .map((row) => row.employeeId),
  };
}
