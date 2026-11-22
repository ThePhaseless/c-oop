// C++ sources the scenarios run.

export const OOP = `#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
struct Base { virtual ~Base() = default; virtual std::string who() const = 0; };
struct A : Base { std::string who() const override { return "A"; } };
struct B : Base { std::string who() const override { return "B"; } };
template <typename T> T twice(T v) { return v + v; }
int main() {
  std::vector<std::unique_ptr<Base>> v;
  v.push_back(std::make_unique<A>()); v.push_back(std::make_unique<B>());
  for (auto& x : v) std::cout << "jestem " << x->who() << "\\n";
  std::cout << twice(21) << " " << twice(std::string("ab")) << "\\n";
  try { throw std::runtime_error("bum"); } catch (const std::runtime_error& e) { std::cout << "zlapano: " << e.what() << "\\n"; }
}
`

// Two prompts without a newline, then a getline loop that ends on EOF.
export const STDIN = `#include <iostream>
#include <string>
int main() {
  std::string a, b;
  std::cout << "Imie? ";
  std::getline(std::cin, a);
  std::cout << "Miasto? ";
  std::getline(std::cin, b);
  std::cout << "[" << a << "|" << b << "]\\n";
  std::string l; int n = 0;
  while (std::getline(std::cin, l)) n++;
  std::cout << "linii: " << n << "\\n";
}
`

export const COMPILE_ERROR = `#include <iostream>
int main() {
  std::cout << "x" << std::endl
  return 0;
}
`

export const WARNING = `#include <iostream>
int main() {
  int nieuzywana = 5;
  std::cout << "wynik-ok\\n";
}
`

export const BUSY_LOOP = `#include <iostream>
int main() {
  std::cout << "przed petla\\n";
  while (true) {}
}
`

export const FLOOD = `#include <iostream>
int main() {
  while (true) std::cout << "zalew zalew zalew zalew zalew zalew zalew zalew\\n";
}
`

export const HELLO = `#include <iostream>
int main() { std::cout << "raz dwa trzy\\n"; }
`

// Answers every line with the same line in brackets, until EOF.
export const ECHO = `#include <iostream>
#include <string>
int main() {
  std::string l;
  while (std::cout << "> " && std::getline(std::cin, l)) std::cout << "[" << l << "]\\n";
}
`
