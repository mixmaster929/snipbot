# wck-contract-bot-2

1) we fixed multiplyer
2) we fixed %gain to capture all transactions and also capture negative gain. 
3) we fixed sell on %gain to work with multiplier
4) we added Max_Gwei to limit tx with high gas
5) we added Max_Weth_Amount if true and if user wanted to buy exact token amount, bot will not buy if cost is more than Maxwethamount
6) we updated so approve be sent immediately after buy
7) we added a module to download Mongo database and store locally in scripts folder (Connect_MongoDB.js) 
8) we added check if the purchase token is in a verified database (TokenDB), only if yes buy. (checklist.json as criteria) 
9) we fixed hotkeysell to use multiplier and also instant sell to use multiplier 
10) we fixed %gain tracker
11) we added MEV. using Flashbots. ---> useFlashBots: true
