// The customer's contact details: only what the booking needs (first name
// and email; last name and phone optional). Same limits as
// createPublicBookingSchema, which the backend applies again: these checks
// only explain mistakes before sending.

export type Contact = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
};

export type ContactField = keyof Contact;

export const EMPTY_CONTACT: Contact = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
};

export const CONTACT_LIMITS = {
  firstName: 120,
  lastName: 120,
  email: 254,
  phone: 30,
} as const;

const PHONE = /^\+?[0-9 ().-]{6,30}$/;
// Shape only (something@domain.tld): the backend has the last word.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const contactMessages = {
  firstName: "Indiquez votre prénom.",
  firstNameLong: "Prénom trop long (120 caractères au plus).",
  lastName: "Nom trop long (120 caractères au plus).",
  email: "Adresse email invalide, par exemple prenom@exemple.fr.",
  phone: "Numéro invalide : chiffres, espaces et + ( ) . - seulement.",
} as const;

/** What is sent: trimmed, email in lower case, empty optionals left out. */
export function canonicalContact(contact: Contact) {
  const lastName = contact.lastName.trim();
  const phone = contact.phone.trim();
  return {
    firstName: contact.firstName.trim(),
    ...(lastName ? { lastName } : {}),
    email: contact.email.trim().toLowerCase(),
    ...(phone ? { phone } : {}),
  };
}

export function checkContact(
  contact: Contact,
): Partial<Record<ContactField, string>> {
  const value = canonicalContact(contact);
  const errors: Partial<Record<ContactField, string>> = {};
  if (!value.firstName) errors.firstName = contactMessages.firstName;
  else if (value.firstName.length > CONTACT_LIMITS.firstName)
    errors.firstName = contactMessages.firstNameLong;
  if ((value.lastName?.length ?? 0) > CONTACT_LIMITS.lastName)
    errors.lastName = contactMessages.lastName;
  if (value.email.length > CONTACT_LIMITS.email || !EMAIL.test(value.email))
    errors.email = contactMessages.email;
  if (value.phone && !PHONE.test(value.phone))
    errors.phone = contactMessages.phone;
  return errors;
}

/** The backend's field errors, in this screen's words. */
export function serverContactErrors(
  fieldErrors: Record<string, string[]> | undefined,
): Partial<Record<ContactField, string>> {
  const errors: Partial<Record<ContactField, string>> = {};
  if (fieldErrors?.firstName) errors.firstName = contactMessages.firstName;
  if (fieldErrors?.lastName) errors.lastName = contactMessages.lastName;
  if (fieldErrors?.email) errors.email = contactMessages.email;
  if (fieldErrors?.phone) errors.phone = contactMessages.phone;
  return errors;
}
