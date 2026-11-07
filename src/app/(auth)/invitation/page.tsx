import type { Metadata } from "next";

import { AuthShell } from "@/features/auth/components/auth-shell";
import { InvitationPasswordForm } from "@/features/auth/components/invitation-password-form";

export const metadata: Metadata = {
  title: "Activer mon invitation",
};

// Where the recovery link of an invited sign-up lands (an account existed
// already for her address; docs/BETA_ACCESS.md). Everything is checked by
// the server action: the session opened by that link, her invitation kept
// on this device.
export default function InvitationPage() {
  return (
    <AuthShell>
      <InvitationPasswordForm />
    </AuthShell>
  );
}
