#include <iostream>
using namespace std;

const int item_count = 4, capacity = 8;
int weight[5] = {0, 2, 3, 4, 5};
int value[5] = {0, 3, 4, 5, 8};
int dp[5][9]; // dp[i][c]：前 i 件物品、容量 c 的最大价值

int main() {
    for (int item = 1; item <= item_count; ++item) {
        for (int c = 0; c <= capacity; ++c) {
            dp[item][c] = dp[item - 1][c];
            if (c >= weight[item]) {
                int candidate = dp[item - 1][c - weight[item]] + value[item];
                if (candidate > dp[item][c]) {
                    dp[item][c] = candidate; // @probe: 选择当前物品
                }
            }
        }
    }
    cout << dp[item_count][capacity] << '\n';
    return 0;
}
