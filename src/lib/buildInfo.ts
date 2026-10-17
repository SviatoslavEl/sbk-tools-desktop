import packageInfo from "../../package.json";

export interface BuildEnvironment {
  artifactVersion?: string;
  revision?: string;
  target?: string;
  installed?: boolean;
}
declare const __SBK_BUILD_INFO__: BuildEnvironment;

/** Build-time values only: this helper never reads the database or file system. */
export function describeBuild(appVersion: string, environment: BuildEnvironment = {}) {
  const artifact = environment.artifactVersion?.replace(/^v/, "") || "";
  const validArtifact = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(artifact) && artifact.length <= 80;
  const revision = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(environment.revision || "") ? environment.revision!.toLowerCase() : "";
  const target = /^[0-9a-z]+(?:-[0-9a-z]+){1,5}$/i.test(environment.target || "") ? environment.target! : "";
  const distribution = validArtifact && Boolean(revision);
  const label = distribution ? artifact : `${appVersion} · разработка / не дистрибутив`;
  const supportText = [
    "СБК Инструменты",
    `Сборка: ${label}`,
    `Версия приложения: ${appVersion}`,
    `Ревизия: ${revision || "не указана"}`,
    ...(target ? [`Платформа сборки: ${target}`] : []),
    `Вариант: ${environment.installed ? "установочный Windows" : "настольный"}`,
  ].join("\n");
  return { label, revision, target, distribution, supportText };
}

export const applicationBuild = describeBuild(packageInfo.version, typeof __SBK_BUILD_INFO__ === "undefined" ? {} : __SBK_BUILD_INFO__);
