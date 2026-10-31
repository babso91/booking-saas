"use client";

import { createContext, useContext, type ReactNode } from "react";

// The host in booking-link previews, always the one the server read: a
// variable absent from the build does not reach the browser's bundle, and
// reading it there would disagree with the server's HTML.
const BookingHostContext = createContext("booking.app");

export function BookingHostProvider({
  host,
  children,
}: {
  host: string;
  children: ReactNode;
}) {
  return (
    <BookingHostContext.Provider value={host}>
      {children}
    </BookingHostContext.Provider>
  );
}

export function BookingHost() {
  return useContext(BookingHostContext);
}
