/**
 * Inline name pools — deliberately NOT a faker dependency (plan §Phase 3).
 *
 * A generated-name library is a moving target: bump the version and every
 * fixture, screenshot and test expectation in the repo shifts. These lists are
 * frozen here instead, so `generateOrg(42)` names the same 250 people forever.
 *
 * 72 × 72 combinations is far more than the 250 the generator needs, but the
 * headroom keeps the collision-suffix path (`ada.lovelace2@example.com`) rare.
 * Emails use `example.com`, which RFC 2606 reserves for exactly this purpose.
 */

export const EMAIL_DOMAIN = "example.com";

export const FIRST_NAMES: readonly string[] = [
  "Ada", "Aisha", "Alejandro", "Amara", "Amir", "Anders", "Anika", "Antoine",
  "Ayana", "Beatriz", "Bram", "Camille", "Carlos", "Chidi", "Clara", "Daniel",
  "Dara", "Diego", "Elena", "Elias", "Emeka", "Esther", "Fatima", "Felix",
  "Freya", "Gabriel", "Grace", "Hana", "Hassan", "Helena", "Ian", "Imani",
  "Ingrid", "Isabel", "Jasper", "Javier", "Jian", "Jonas", "Julia", "Kai",
  "Kavya", "Keiko", "Kenji", "Lars", "Layla", "Leon", "Lucia", "Malik",
  "Marcus", "Mariam", "Mateo", "Maya", "Mei", "Nadia", "Nikhil", "Nina",
  "Noor", "Olivier", "Omar", "Priya", "Rafael", "Rania", "Rohan", "Rosa",
  "Sana", "Sofia", "Soren", "Tariq", "Theo", "Vera", "Yusuf", "Zara",
];

export const LAST_NAMES: readonly string[] = [
  "Abara", "Adeyemi", "Ahmadi", "Almeida", "Andersen", "Bakker", "Baptiste", "Bergman",
  "Bhatt", "Blanchard", "Cabrera", "Cardoso", "Castillo", "Chandra", "Chen", "Conti",
  "Correia", "Dahl", "Dalmau", "Delacroix", "Diallo", "Dubois", "Eriksen", "Farah",
  "Ferreira", "Fontaine", "Gallagher", "Ganesan", "Gerber", "Gomes", "Haddad", "Hallberg",
  "Hayashi", "Herrera", "Ibarra", "Iqbal", "Jansen", "Jimenez", "Kaminski", "Kapoor",
  "Karlsson", "Khoury", "Kimura", "Kovac", "Laurent", "Lindqvist", "Maleki", "Mancini",
  "Mbeki", "Mendes", "Moreau", "Nakamura", "Nasser", "Novak", "Okafor", "Oliveira",
  "Osei", "Pereira", "Petrov", "Quintero", "Rahman", "Ramirez", "Reyes", "Sandoval",
  "Sharma", "Silva", "Sorensen", "Tanaka", "Vasquez", "Vogel", "Watanabe", "Zielinski",
];
