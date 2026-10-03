/*
  naming.js —— 名字怎么从 modId 推出来
  ====================================

  为什么单独一个文件：模板和各个子工具【必须用同一套规则】。

  这里踩过一个很贵的坑：主类名是按 modId 推的（`lab3081` → `Lab3081`），
  但方块/酿造/效果/生物那几个工具的模板里把类名【写死】成了 `MyMod`。
  于是生成出来的工程编译不过：

      ModBlocks.java:24: error: cannot find symbol
              Identifier ident = Identifier.of(MyMod.MOD_ID, id);
                                       ^
        symbol: variable MyMod

  更坑的是：测试没抓到。因为 verify 的"缺 MC 库"过滤是把所有
  cannot find symbol 一起吃掉的，而 MyMod 是【本工程自己的符号】，
  压根不是缺库。最后是让 AI 在真机上跑了一次、它自己发现的。

  现在这里是唯一的一份规则，谁都不许再写死类名。
*/

/**
 * modId → Java 主类名。
 * `mod_faa1d1ab` → `ModFaa1d1ab`（每段首字母大写，其余保持）
 */
export function mainClass(modId) {
  const s = String(modId || 'mod')
  return s.replace(/(^|_)(\w)/g, (_, __, c) => c.toUpperCase())
}

/** modId → Java 包名（现在统一挂在 com.example 下面） */
export function mainPackage(modId) {
  return 'com.example.' + String(modId || 'mod')
}

/** modId → 包路径（`com.example.foo` → `com/example/foo`） */
export function packagePath(modId) {
  return mainPackage(modId).replace(/\./g, '/')
}

export const __test = { mainClass, mainPackage, packagePath }
