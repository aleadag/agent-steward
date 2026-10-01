system:
let
  common = [
    { name = "@types/bun"; version = "1.4.2"; hash = "sha512-GimotNn7+ZV0uVArItBbriZsR1oNf0+WTzPkdcFrzShI7k2norL0uzEaJT8T33dWr7O/c9ZDuAFQrctKCi72oQ=="; }
    { name = "@types/node"; version = "22.18.6"; hash = "sha512-r8uszLPpeIWbNKtvWRt/DbVi5zbqZyj1PTmhRMqBMvDnaz1QpmSKujUtJLrqGZeoM8v72MfYggDceY4K1itzWQ=="; }
    { name = "bun-types"; version = "1.4.2"; hash = "sha512-bxV1FgK7yBIzjRe5zBozIM4Bem11ZJcCXSrjWRG3YWLt8yFDePu4cLjpebO8OvPeIE9trbyPF4fuj3Cia4Fj3w=="; }
    { name = "oxfmt"; version = "0.71.0"; hash = "sha512-lUPUl0d/+Io5pDrsPXWs6rB4N/bpB78oj9CTDpnbulfDz+0r3XXcHPlQ7kRPJ2GjIT4nX+/mcqunOeP9BvsEtg=="; }
    { name = "oxlint"; version = "1.86.0"; hash = "sha512-og0lhgvZfgGF//gOOmZXvtr+GmBbAGEnbEhv/QUg7UW2Wi4wHMnJbnMD+zuHgPdJxdklfgpPupdlAaAySyxrZg=="; }
    { name = "tinypool"; version = "2.2.0"; hash = "sha512-jBrmx4lYmaC9k/mgPbylxs7kBUxHtD8256up+HjLaDFfXScKJQyil+SWXSvhAtT7XHo+yTVlpB81PGmHP8oLSQ=="; }
    { name = "typescript"; version = "5.9.3"; hash = "sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw=="; }
    { name = "undici-types"; version = "6.21.0"; hash = "sha512-iwDZqg0QAGrg9Rav5H4n0M64c3mkR59cJ6wQp+7C4nI0gsmExaedaYLNO44eT4AtBBwjbTiGPMlt2Md0T9H9JQ=="; }
    { name = "zod"; version = "4.1.12"; hash = "sha512-JInaHOamG8pt5+Ey8kGmdcAcg3OL9reK8ltczgHTAwNhMys/6ThXHityHxVV2p3fkw/c+MAvBHFVYHFZDmjMCQ=="; }
  ];
  native = {
    x86_64-linux = [
      { name = "@oxfmt/binding-linux-x64-gnu"; version = "0.71.0"; hash = "sha512-5/Z6pUewQpknXqC4/ykK6Zc6RiteAnPem1Ci7K1RZLVF6w6MMjwHjR4vsjijW4Czidgv7HKeVglGjElADliT9w=="; }
      { name = "@oxfmt/binding-linux-x64-musl"; version = "0.71.0"; hash = "sha512-uVdG2N/4GEbOeljpQ+xv+NeEwJWJGj0WaxSiSYnoiqIYy3RWrWd3rGUmxWXP1A8+ferNvvwFoDAtvgsDUvBuSw=="; }
      { name = "@oxlint/binding-linux-x64-gnu"; version = "1.86.0"; hash = "sha512-C1WjukSyMnr66b+w1/tV8RFVv6d9v0MzDf4p9IxVXknqgmTHBgZh1pccN1eHzFr0b9Tbb3OXoPsAAdAuHAQfeA=="; }
      { name = "@oxlint/binding-linux-x64-musl"; version = "1.86.0"; hash = "sha512-ap6KLmvC38c6MdYzsIh25cXQupqYvjd37tMNftzrX1DCtkX1Gcf2B+S2B17dD4lKa5c5gJog7DQJyDo82PBKyw=="; }
    ];
    aarch64-linux = [
      { name = "@oxfmt/binding-linux-arm64-gnu"; version = "0.71.0"; hash = "sha512-7VgJIrywCwR/G6YMv+HqsccUt8Z4q4mbM2xR+Ry/6AeMk4pCmZ9aO4Srd3mmrvVu8PsCZGP7oHEHSXWTmyloaQ=="; }
      { name = "@oxfmt/binding-linux-arm64-musl"; version = "0.71.0"; hash = "sha512-AOCaminv/+fhinUXKvtPZT4POhNYmN9GfvaJdgJa1AbvuzClWGwDIXfJg8eu3sYaVL2B68jNvmS7LZGAYa0z3A=="; }
      { name = "@oxlint/binding-linux-arm64-gnu"; version = "1.86.0"; hash = "sha512-EM6wy5c2UM12qPb7iDJDBAZvHyfEJGH6iosFgaFiaRZpirz99//EHcUyD2KAskz07x1TULuiAtsojf4nvWWksw=="; }
      { name = "@oxlint/binding-linux-arm64-musl"; version = "1.86.0"; hash = "sha512-vCiUQb9ZNzZalxYRU4mlZwUqT5f+c7Sk9DwUOplWHtik3Dl4r3DVnUB5tBeRuTAUe6MUVCTylNW7TkkN8J1oTw=="; }
    ];
    aarch64-darwin = [
      { name = "@oxfmt/binding-darwin-arm64"; version = "0.71.0"; hash = "sha512-pTteTrN88DicrmJ3DocBmpNDa6Umfh0iveEG8rnAlDFQpclmtDS7hnIvZbIEV9mDO0Ot1U0sjtoJQ1itd/ZMhQ=="; }
      { name = "@oxlint/binding-darwin-arm64"; version = "1.86.0"; hash = "sha512-h+vkOr4ik6KLFCXdtNVEj9xfnXfNUpPoF95QjORdhiSpLqQePzcN81kGHjAgsw1/G7WBWK5KsFKbI2UK8EyzMA=="; }
    ];
  };
in
common ++ native.${system}
