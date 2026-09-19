-- The shop no longer buys back +7/+1 numbers: the sell-your-number offer flow
-- was removed. This drops the (optional) number_offers table and its partial
-- index so existing installs lose the unused buyback surface.
DROP TABLE IF EXISTS number_offers;