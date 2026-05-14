/**
 * Input Adapter Base Class
 * 
 * 适配器模式：将不同类型的输入目标（标准 input/textarea/contenteditable 和 Google Docs）
 * 统一为相同的接口，实现输入逻辑的解耦。
 */

class InputAdapter {
  /**
   * 检测当前环境是否支持此适配器
   * @returns {boolean} 是否支持
   */
  static detect() {
    throw new Error('detect() must be implemented by subclass');
  }

  /**
   * 获取输入目标元素
   * @param {boolean} useActiveElement - 是否使用当前活动元素
   * @returns {Promise<{element: HTMLElement, error?: string}>}
   */
  async getTarget(useActiveElement = true) {
    throw new Error('getTarget() must be implemented by subclass');
  }

  /**
   * 输入单个字符
   * @param {HTMLElement} element - 目标元素
   * @param {string} char - 要输入的字符
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async typeCharacter(element, char) {
    throw new Error('typeCharacter() must be implemented by subclass');
  }

  /**
   * 聚焦到目标元素
   * @param {HTMLElement} element - 目标元素
   * @returns {Promise<void>}
   */
  async focus(element) {
    element.focus();
    await this._sleep(50);
  }

  /**
   * 清空目标元素内容（可选）
   * @param {HTMLElement} element - 目标元素
   * @returns {Promise<void>}
   */
  async clear(element) {
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      element.value = '';
    } else if (element.contentEditable === 'true' || element.isContentEditable) {
      element.textContent = '';
    }
  }

  /**
   * 模拟退格键删除一个字符
   * @param {HTMLElement} element - 目标元素
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async simulateBackspace(element) {
    throw new Error('simulateBackspace() must be implemented by subclass');
  }

  /**
   * 延迟函数
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

