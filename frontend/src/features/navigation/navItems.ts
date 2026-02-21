export type NavItem = {
  label: string;
  href: string;
};

export const dashboardNavItems: NavItem[] = [
  { label: "Home", href: "/dashboard" },
  { label: "Games", href: "/dashboard/games" },
  { label: "My Profile", href: "/dashboard/profile" },
  { label: "Leaderboard", href: "/dashboard/leaderboard" },
];

