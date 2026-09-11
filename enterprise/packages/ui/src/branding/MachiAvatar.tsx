import * as React from "react";
import { cn } from "../lib/cn";

type MachiAvatarProps = {
  className?: string;
  size?: number;
  src?: string;
};

/**
 * Backwards-compatible avatar component name retained for existing imports.
 * The default asset is the neutral AgenticX Ontology mark.
 */
export function MachiAvatar({ className, size = 96, src = "/agenticx-ontology-logo.svg" }: MachiAvatarProps) {
  const isDefaultLogo = src === "/agenticx-ontology-logo.svg";
  return (
    <span
      className={cn(
        "relative inline-flex items-center justify-center overflow-hidden rounded-md",
        className
      )}
      style={{ width: size, height: size }}
      aria-label="AgenticX Ontology avatar"
    >
      <img
        src={src}
        alt="AgenticX Ontology"
        width={size}
        height={size}
        className={cn(
          "h-full w-full object-cover",
          isDefaultLogo && "dark:invert opacity-90 dark:opacity-100"
        )}
      />
    </span>
  );
}
