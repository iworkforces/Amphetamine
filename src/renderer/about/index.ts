/**
 * About window renderer — classic macOS-style About panel.
 * All privileged access goes through window.api (preload).
 */
import "./styles.css";
import { bindIconAuroraStagePause } from "../icon-aurora-pause.js";

const heroIcon = new URL("../../assets/settings-hero-icon.png", import.meta.url).toString();

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) {
    throw new Error(`[about] Missing element #${id}`);
  }
  return el as T;
}

function openRepository(url: string): void {
  // Main process setWindowOpenHandler allowlists the package repository URL.
  window.open(url, "_blank", "noopener,noreferrer");
}

function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
}

/** Drop focus from the GitHub icon (first tabbable) after show. */
function clearIconFocus(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) {
    active.blur();
  }
}

function scheduleClearIconFocus(): void {
  const run = (): void => {
    if (document.visibilityState === "visible") {
      clearIconFocus();
    }
  };
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(run);
    });
  } else {
    run();
  }
}

function onAboutVisibilityChange(): void {
  if (document.visibilityState !== "visible") {
    return;
  }
  // Double rAF: run after Chromium's focus-restore on BrowserWindow.show().
  scheduleClearIconFocus();
}

/**
 * Opt-in open animation (opacity only — scale lives on aurora bloom so we
 * do not double-scale the whole About surface). Default paint is always
 * visible (safe if bootstrap fails).
 */
function startOpenAnimation(root: HTMLElement): void {
  if (prefersReducedMotion()) {
    root.classList.add("ready");
    return;
  }
  root.classList.add("pre-animate");
  const finish = (): void => {
    root.classList.remove("pre-animate");
    root.classList.add("ready");
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      requestAnimationFrame(finish);
    });
  } else {
    finish();
  }
  window.setTimeout(finish, 500);
}

async function bootstrap(): Promise<void> {
  if (window.api.platform.os === "win32") {
    document.body.classList.add("platform-win32");
  }

  const root = requireEl<HTMLDivElement>("app");
  // Wire pause before any await so warm-cache hide during getAbout still freezes leaves.
  bindIconAuroraStagePause(root);
  // Materialize immediately so a failed getAbout() never leaves a blank window.
  startOpenAnimation(root);
  // Chromium focuses the first tabbable (GitHub icon) on show; About opens unfocused.
  clearIconFocus();
  scheduleClearIconFocus();
  document.addEventListener("visibilitychange", onAboutVisibilityChange);

  const icon = requireEl<HTMLImageElement>("app-icon");
  const productNameEl = requireEl<HTMLHeadingElement>("product-name");
  const versionEl = requireEl<HTMLDivElement>("version");
  const descriptionEl = requireEl<HTMLDivElement>("description");
  const copyrightEl = requireEl<HTMLDivElement>("copyright");

  icon.src = heroIcon;

  try {
    const info = await window.api.app.getAbout();
    productNameEl.textContent = info.productName;
    document.title = `About ${info.productName}`;
    icon.alt = "";
    versionEl.textContent = `Version ${info.version}`;
    descriptionEl.textContent = info.description;
    const author = info.author.trim().length > 0 ? info.author.trim() : info.productName;
    copyrightEl.textContent = `Copyright © ${new Date().getFullYear()} ${author}. All rights reserved.`;

    const openRepo = (): void => {
      openRepository(info.repository);
    };
    icon.addEventListener("click", openRepo);
    icon.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openRepo();
      }
    });
  } catch (err: unknown) {
    console.error("[about] getAbout failed:", err);
    versionEl.textContent = "Version unknown";
    descriptionEl.textContent = "Could not load package information.";
    copyrightEl.textContent = `Copyright © ${new Date().getFullYear()}`;
  }

  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      window.close();
    }
  });
}

void bootstrap().catch((err: unknown) => {
  console.error("[about] bootstrap failed:", err);
  const root = document.getElementById("app");
  if (root !== null) {
    root.classList.remove("pre-animate");
    root.classList.add("ready");
  }
});
