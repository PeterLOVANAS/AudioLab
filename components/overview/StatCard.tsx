import type { LucideIcon } from "lucide-react";

type StatCardProps = {
  label: string;
  value: number;
  note: string;
  icon: LucideIcon;
};

export default function StatCard({ label, value, note, icon }: StatCardProps) {
  const Icon = icon;

  // How Icon variable related to <Icon />? The Icon variable is assigned the value of the icon prop, which is a LucideIcon component. This allows us to use the Icon variable as a component in the JSX, rendering the specific icon passed as a prop to the StatCard component.
  // For example if Icon= Headphones, then <Icon /> will render the Headphones icon from the Lucide library. aka <Headphones / size = {19}>

  // Javascript return the JSX for one stat card.
  return (
    <article className="al-stat-card">
      {/* JSX: First row containing the card label and icon */}
      <div className="al-stat-top">
        <span>{label}</span>
        <Icon size={19} />{" "}
        {/* <Icon /> is the icon component from the Lucide library */}
      </div>

      {/* JSX: Display the numeric value */}
      <strong className="al-stat-value">
        {value} {/* Insert value from patent component */}
      </strong>

      {/* JSX: Display the note */}
      <small className="al-stat-note">{note}</small>
    </article>
  );
}
