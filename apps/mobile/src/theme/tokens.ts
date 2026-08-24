/**
 * Минимальная дизайн-система USTAL: простая, доверительная, современная,
 * человечная, удобная для одной руки. См. docs/screens.md.
 */
export const colors = {
  background: "#FFFFFF",
  surface: "#F5F5F7",
  surfaceAlt: "#EFEFF4",
  border: "#E1E1E6",
  textPrimary: "#16161A",
  textSecondary: "#6B6B76",
  textInverse: "#FFFFFF",
  primary: "#2F6FED",
  primaryPressed: "#2557C4",
  success: "#1E9E5A",
  warning: "#C97A1D",
  danger: "#D8483C",
  matchExact: "#1E9E5A",
  matchProbable: "#2F6FED",
  matchNewOpportunity: "#8A5CF6",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radii = {
  sm: 8,
  md: 12,
  lg: 20,
  pill: 999,
} as const;

export const typography = {
  title: { fontSize: 22, fontWeight: "700" as const },
  subtitle: { fontSize: 17, fontWeight: "600" as const },
  body: { fontSize: 15, fontWeight: "400" as const },
  caption: { fontSize: 13, fontWeight: "400" as const },
};

export const shadows = {
  card: {
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
};
