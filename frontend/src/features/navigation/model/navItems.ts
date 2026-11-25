export type NavItem = {
  label: string;
  href: string;
};

export const dashboardNavItems: NavItem[] = [
  { label: "Home", href: "/dashboard" },
  { label: "Games", href: "/dashboard/games" },
  { label: "My Profile", href: "/dashboard/profile" },
  { label: "Leaderboard", href: "/dashboard/leaderboard" },
  { label: "Host Panel", href: "/dashboard/host" },
  { label: "Creator Console", href: "/dashboard/creator" },
  { label: "Settings", href: "/arena/settings" },
];

