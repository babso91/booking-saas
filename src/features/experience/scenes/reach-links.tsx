"use client";

import { cn } from "@/lib/cn";

import { Detail, useEngine } from "../engine/engine";
import { contactChannels, shownLinks } from "../reach";

const link =
  "inline-flex min-h-11 items-center underline decoration-[var(--u-line)] underline-offset-4 hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current";

/**
 * Her channels (call, WhatsApp, write) and her links elsewhere, in her
 * universe's words (Higani points 3 and 4): at the foot of her page and in
 * her menu, one tap from anywhere. Nothing when she filled in nothing.
 */
export function ReachLinks({ className }: { className?: string }) {
  const { config } = useEngine();
  const channels = contactChannels(config.practical);
  const links = shownLinks(config.links);
  if (!channels.length && !links.length) return null;
  return (
    <div className={cn("flex flex-col", className)}>
      {channels.length ? (
        <ul aria-label="Contact" className="flex flex-wrap gap-x-6">
          {channels.map((channel) => (
            <li key={channel.kind}>
              <a
                href={channel.href}
                aria-label={`${channel.label}, ${channel.text}`}
                className={link}
                {...(channel.kind === "whatsapp"
                  ? { target: "_blank", rel: "noopener noreferrer" }
                  : {})}
              >
                <Detail>{channel.label}</Detail>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {links.length ? (
        <ul aria-label="Réseaux et liens" className="flex flex-wrap gap-x-6">
          {links.map((item, position) => (
            <li key={position}>
              <a
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                className={link}
              >
                <Detail>{item.label}</Detail>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
