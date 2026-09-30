// Opt-in synthetic experiment corpus. Never sent by ordinary test lanes.
export type ActivationClass = "not_needed" | "needed" | "borderline";
export type ActivationPrompt = {
  id: string; language: "ru" | "en"; class: ActivationClass;
  expected: "inactive" | "active" | "optional"; text: string;
  files?: { name: string; mimeType: string; text?: string; fixture?: string }[];
  oracle?: string; office?: boolean; search?: boolean;
};
export const activationPrompts: readonly ActivationPrompt[] = [
  { id: "D01", language: "ru", class: "not_needed", expected: "inactive", text: "Привет! У меня был тяжёлый день. Напиши пару тёплых слов поддержки." },
  { id: "D02", language: "en", class: "not_needed", expected: "inactive", text: "Explain the difference between a metaphor and a simile, with one short example of each." },
  { id: "D03", language: "ru", class: "not_needed", expected: "inactive", text: "Посоветуй три простых способа меньше отвлекаться при чтении книги." },
  { id: "D04", language: "en", class: "not_needed", expected: "inactive", text: "Write a friendly two-sentence invitation to a picnic next Saturday. Do not invent a location." },
  { id: "D05", language: "ru", class: "not_needed", expected: "inactive", text: "Отредактируй фразу, убрав канцелярит: «Настоящим уведомляем о необходимости осуществления проверки оборудования до начала работ»." },
  { id: "D06", language: "en", class: "not_needed", expected: "inactive", text: "Translate into Spanish: 'The library is closed today. It will open tomorrow at nine.'" },
  { id: "D07", language: "ru", class: "not_needed", expected: "inactive", text: "Сожми до одного предложения: Команда встретилась в понедельник. Анна показала макет. Борис предложил изменить цвет кнопки. Все согласились проверить два варианта в четверг." },
  { id: "D08", language: "en", class: "not_needed", expected: "inactive", text: "Show a short JavaScript example of filtering positive numbers from an array. I only want to read the snippet; do not execute it." },
  { id: "D09", language: "ru", class: "not_needed", expected: "inactive", text: "Почему сменяются времена года? Объясни в трёх предложениях для школьника." },
  { id: "D10", language: "en", class: "not_needed", expected: "inactive", text: "Suggest five short names for a fictional neighborhood book club." },
  { id: "N01", language: "ru", class: "needed", expected: "active", text: "Запусти Python-код print(sum(i*i for i in range(1, 11))) и сообщи фактический вывод.", oracle: "squares" },
  { id: "N02", language: "en", class: "needed", expected: "active", text: "Calculate the exact total quantity times unit_price from the attached CSV using Python. Report the monetary total with two decimal places.", files: [{ name: "items.csv", mimeType: "text/csv", text: "item,quantity,unit_price\nA,3,2.50\nB,2,8.00\n" }], oracle: "total" },
  { id: "N03", language: "ru", class: "needed", expected: "active", text: "Преобразуй приложенный JSON в скачиваемый records.csv с колонками name,score, сохрани порядок строк.", files: [{ name: "records.json", mimeType: "application/json", text: '[{"name":"Ada","score":7},{"name":"Lin","score":9}]' }], oracle: "csv" },
  { id: "N04", language: "en", class: "needed", expected: "active", text: "Create a downloadable welcome.docx with the title Welcome and the paragraph: The workshop starts at 09:00. Bring a notebook. Keep it to one page.", oracle: "docx", office: true },
  { id: "N05", language: "ru", class: "needed", expected: "active", text: "Исправь приложенный sum_values.py: функция sum_values должна возвращать сумму списка, в том числе 0 для пустого. Запусти проверки assert sum_values([2,3,4]) == 9 и assert sum_values([]) == 0. Предоставь исправленный sum_values.py для скачивания и сообщи результат проверок.", files: [{ name: "sum_values.py", mimeType: "text/x-python", text: "def sum_values(values):\n    return len(values)\n" }], oracle: "code" },
  { id: "N06", language: "en", class: "needed", expected: "active", text: "Inspect the attached archive. How many regular files does it contain, and what is the exact total number of uncompressed bytes? Read the actual archive and report both numbers.", files: [{ name: "sample.zip", mimeType: "application/zip", fixture: "archive" }], oracle: "inspect" },
  { id: "N07", language: "ru", class: "needed", expected: "active", text: "Создай скачиваемый bundle.zip с двумя файлами: alpha.txt с единственной строкой alpha и beta.txt с единственной строкой beta. Обе строки должны оканчиваться переводом строки.", oracle: "zip" },
  { id: "N08", language: "en", class: "needed", expected: "active", text: "Draw a bar chart for sales A=4, B=7, C=3. Label both axes and provide the chart as a downloadable sales.png image.", oracle: "chart" },
  { id: "N09", language: "ru", class: "needed", expected: "active", text: "Сделай скачиваемую презентацию plan.pptx из трёх слайдов с заголовками Plan, Build, Review. На каждом слайде добавь одно короткое предложение о соответствующем этапе работы.", oracle: "pptx", office: true },
  { id: "N10", language: "en", class: "needed", expected: "active", text: "Create a downloadable budget.xlsx. On a sheet named Budget put Item and Amount in A1:B1, Pens and 12 in A2:B2, Paper and 8 in A3:B3, Total and the formula =SUM(B2:B3) in A4:B4. Format amounts with two decimal places.", oracle: "xlsx", office: true },
  { id: "B01", language: "ru", class: "borderline", expected: "optional", text: "Какая стабильная версия Python сейчас последняя? Если не можешь проверить свежие сведения, прямо скажи об этом." },
  { id: "B02", language: "en", class: "borderline", expected: "optional", text: "What is the latest stable version of Python right now? If you cannot verify current information, say so clearly.", search: true },
  { id: "B03", language: "ru", class: "borderline", expected: "optional", text: "Напиши письмо управляющему дома с просьбой починить освещение у входа. Тон вежливый, длина около 100 слов." },
  { id: "B04", language: "en", class: "borderline", expected: "optional", text: "Make a table comparing bicycles, buses, and walking for a 3 km city commute. Include cost, flexibility, and exercise." },
  { id: "B05", language: "ru", class: "borderline", expected: "optional", text: "Вычисли точно: 18347 × 29681 + 57439 × 8123 − 918273. Покажи результат и коротко объясни проверку." },
  { id: "B06", language: "en", class: "borderline", expected: "optional", text: "Write a Python function that groups a list of words by their first letter, ignoring case and empty strings." },
  { id: "B07", language: "ru", class: "borderline", expected: "optional", text: "Проверь регулярное выражение ^[A-Z]{2}-[0-9]{4}$ на примерах AB-1234, A-1234, ab-1234, ZZ-0000. Объясни, какие строки подходят." },
  { id: "B08", language: "en", class: "borderline", expected: "optional", text: "What date is 137 days after 18 February 2027? Treat the starting day as day zero." },
  { id: "B09", language: "ru", class: "borderline", expected: "optional", text: "Что написано на кнопке в приложенном скриншоте и какого она цвета?", files: [{ name: "screen.png", mimeType: "image/png", fixture: "screenshot" }] },
  { id: "B10", language: "en", class: "borderline", expected: "optional", text: "Sort these people by score descending, breaking ties alphabetically by name: Nora 12, Amir 9, Zoe 12, Ben 15, Cora 9, Eli 11. Show the result as a table." }
];
