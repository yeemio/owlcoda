这是一段不包含任何 markdown 结构标记的纯文本回复。
模型在大多数短回答里输出的就是这种形态。
应当走 fast path，不进 normalizer，不进 token renderer。
