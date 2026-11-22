"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { callAction } from "@/features/auth/client/call-action";

import { listDuplicateCandidatesAction } from "../actions/duplicates";

/**
 * A quiet link to the records that look alike (point 147), only when there
 * are some. Says nothing otherwise, nor on a failed read (a practitioner, a
 * lost connection): the directory stays as it was.
 */
export function DuplicateHint() {
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let current = true;
    void callAction(() => listDuplicateCandidatesAction()).then((result) => {
      if (current && result.ok) setTotal(result.data.total);
    });
    return () => {
      current = false;
    };
  }, []);

  if (!total) return null;
  return (
    <Link
      href="/app/clients/doublons"
      className="w-fit text-[14px] font-medium text-ink-soft underline decoration-line-strong underline-offset-4 hover:text-ink"
    >
      {total > 1
        ? `${total} doublons possibles à vérifier`
        : "1 doublon possible à vérifier"}
    </Link>
  );
}
