import { Button } from "../ui/button";

export function TeamChoiceRow<T extends string>(props: {
  readonly label: string;
  readonly value: T;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly disabled?: boolean;
  readonly onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium">{props.label}</span>
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label={props.label}>
        {props.options.map((option) => (
          <Button
            key={option.value}
            size="xs"
            variant={option.value === props.value ? "secondary" : "ghost"}
            aria-pressed={option.value === props.value}
            disabled={props.disabled === true}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
