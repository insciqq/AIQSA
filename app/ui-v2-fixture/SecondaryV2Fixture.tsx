import { PublicShareView } from "@/components/share/PublicShareView";

export function SecondaryV2Fixture() {
  return (
    <PublicShareView
      snapshot={{
        messages: [
          {
            content: {
              blocks: [{
                text: "Собери спокойный краткий обзор и сохрани проверяемые ссылки.",
                type: "text"
              }]
            },
            role: "user"
          },
          {
            content: {
              blocks: [{
                text: "Готово. Это фиксированная публичная копия видимой ветви без приватных вложений и внутренних evidence-данных.",
                type: "text"
              }]
            },
            role: "assistant"
          }
        ],
        title: "Public product brief",
        version: 1
      }}
      title="Public product brief"
    />
  );
}
